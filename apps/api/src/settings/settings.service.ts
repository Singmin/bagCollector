import { Injectable } from '@nestjs/common';
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
