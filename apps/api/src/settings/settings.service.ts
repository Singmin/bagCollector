import { Injectable } from '@nestjs/common';
import { COLOR_SCAN_MODEL, DEFAULT_SCAN_SETTINGS, DINO_SCAN_MODEL, type ScanSettings } from '@bagcollect/bag-vision';
import { scanSettingsSchema } from '@bagcollect/contracts';
import { ApiError } from '../common/api-error.js';
import type { MatchSettingsDto, MatchSettingsInput } from '@bagcollect/contracts';
import { env } from '../common/env.js';
import { PrismaService } from '../database/prisma.service.js';

/** 设置键。带前缀是为了将来加别的设置时不撞名。 */
const KEY_AUTO = 'match.autoThreshold';
const KEY_CANDIDATE = 'match.candidateThreshold';
const KEY_LIMIT = 'match.candidateLimit';

/**
 * 运行时可变的应用设置。
 *
 * 与 env 的分工很清楚：env 管「部署时确定、改动要重启容器」的基础设施配置；
 * 这里管「运营期间要调的业务参数」。目前只有扫描匹配的判定阈值 ——
 * 它天生要拿真实数据反复校准，每调一次都改 .env 再重启 api 容器是不可接受的。
 *
 * 库里没有的键一律回退到 env 的默认值，所以这张表为空、或者只改了一部分，
 * 系统都照常工作。
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async scanSettings(): Promise<ScanSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'scan.settings' } });
    try {
      return scanSettingsSchema.parse({ ...DEFAULT_SCAN_SETTINGS, ...(row ? JSON.parse(row.value) : {}) });
    } catch { return { ...DEFAULT_SCAN_SETTINGS }; }
  }

  async scanCoverage(engine: 'color' | 'dino' = 'dino') {
    const model = engine === 'dino' ? DINO_SCAN_MODEL : COLOR_SCAN_MODEL;
    const bags = await this.prisma.officialBag.findMany({
      where: { status: 'PUBLISHED', processStatus: 'READY' },
      select: { id: true, version: true, images: { where: { status: 'AVAILABLE', kind: { in: ['CUTOUT', 'DISPLAY'] } }, select: { version: true, kind: true } },
        scanEmbeddings: { where: { model, referenceKey: 'primary' }, select: { sourceVersion: true, sourceKind: true, vector: true, colorVector: true } } }
    });
    const ready = bags.filter(b => {
      const source = b.images.find(i => i.version === b.version && i.kind === 'CUTOUT') ?? b.images.find(i => i.version === b.version && i.kind === 'DISPLAY');
      return source && b.scanEmbeddings.some(e => e.sourceVersion === source.version && e.sourceKind === source.kind &&
        e.vector.length === (engine === 'dino' ? 384 : 389) && e.colorVector.length === 389 && [...e.vector, ...e.colorVector].every(Number.isFinite));
    }).length;
    return { model, total: bags.length, ready, missing: bags.length - ready };
  }

  async updateScanSettings(adminId: string, input: ScanSettings) {
    const old = await this.scanSettings();
    if (input.engine !== old.engine && input.engine === 'dino') {
      const coverage = await this.scanCoverage();
      if (!coverage.total || coverage.missing) throw new ApiError('CONFLICT', '新模型主参考向量尚未全部就绪，请先补算', 409);
      try {
        const serviceUrl = process.env.VISION_SERVICE_URL;
        if (!serviceUrl) throw new Error('not configured');
        const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/health/ready`, { signal: AbortSignal.timeout(3000) });
        const health = await response.json() as { model?: string };
        if (!response.ok || health.model !== DINO_SCAN_MODEL) throw new Error('model not ready');
      } catch { throw new ApiError('CONFLICT', 'DINO 模型服务尚未就绪或版本不一致', 409); }
    }
    await this.prisma.$transaction([
      this.prisma.appSetting.upsert({ where: { key: 'scan.settings' }, create: { key: 'scan.settings', value: JSON.stringify(input) }, update: { value: JSON.stringify(input) } }),
      this.prisma.auditLog.create({ data: { adminId, action: 'SCAN_SETTINGS_UPDATE', targetId: 'settings', metadata: { ...input } } })
    ]);
    return input;
  }

  private defaults(): MatchSettingsDto {
    const config = env();
    return {
      autoThreshold: config.BAG_MATCH_AUTO_THRESHOLD,
      candidateThreshold: config.BAG_MATCH_CANDIDATE_THRESHOLD,
      candidateLimit: config.BAG_MATCH_CANDIDATE_LIMIT
    };
  }

  /**
   * 当前生效的匹配阈值。
   *
   * 刻意不加内存缓存：这是「每次匹配读一次」的低频路径，而阈值恰恰是最需要
   * 「改完立刻生效」的参数 —— 加缓存只会让运营改完看不见变化，然后开始怀疑
   * 是不是没生效、要不要重启。三个主键查询的开销远小于这种困惑的代价。
   */
  async matchSettings(): Promise<MatchSettingsDto> {
    const fallback = this.defaults();
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: [KEY_AUTO, KEY_CANDIDATE, KEY_LIMIT] } }
    });
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return {
      autoThreshold: this.readNumber(stored.get(KEY_AUTO), fallback.autoThreshold),
      candidateThreshold: this.readNumber(stored.get(KEY_CANDIDATE), fallback.candidateThreshold),
      candidateLimit: this.readInt(stored.get(KEY_LIMIT), fallback.candidateLimit)
    };
  }

  /** 解析不出来就回退默认：库里存了脏数据不该把匹配接口整个搞挂。 */
  private readNumber(raw: string | undefined, fallback: number) {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readInt(raw: string | undefined, fallback: number) {
    const value = this.readNumber(raw, fallback);
    return Number.isInteger(value) ? value : Math.max(1, Math.round(value));
  }

  /** 写入设置并记审计。返回落库后实际生效的值，前端直接拿它刷新表单。 */
  async updateMatchSettings(adminId: string, input: MatchSettingsInput): Promise<MatchSettingsDto> {
    const entries: [string, string][] = [
      [KEY_AUTO, String(input.autoThreshold)],
      [KEY_CANDIDATE, String(input.candidateThreshold)],
      [KEY_LIMIT, String(input.candidateLimit)]
    ];
    await this.prisma.$transaction([
      ...entries.map(([key, value]) =>
        this.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
      ),
      this.prisma.auditLog.create({
        data: { adminId, action: 'MATCH_SETTINGS_UPDATE', targetId: 'settings', metadata: input }
      })
    ]);
    return this.matchSettings();
  }
}
