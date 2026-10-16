import { HttpStatus, Injectable } from '@nestjs/common';
import {
  addWhiteStroke,
  DEFAULT_STROKE_PARAMS,
  hasAlpha,
  strokeParamsSchema,
  type StrokeParams
} from '@bagcollect/stroke';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';

const STROKE_KEY = 'stroke.settings';

/**
 * 白描边参数预览与配置。
 *
 * 参数存 AppSetting（key=stroke.settings），worker 出图时读同一份配置，后台改完即生效。
 * 库里没有时回退到 DEFAULT_STROKE_PARAMS，因此表为空也能正常工作。
 */
@Injectable()
export class StrokePreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async settings(): Promise<StrokeParams> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: STROKE_KEY } });
    try {
      return strokeParamsSchema.parse({ ...DEFAULT_STROKE_PARAMS, ...(row ? JSON.parse(row.value) : {}) });
    } catch {
      return { ...DEFAULT_STROKE_PARAMS };
    }
  }

  async updateSettings(adminId: string, input: StrokeParams): Promise<StrokeParams> {
    await this.prisma.$transaction([
      this.prisma.appSetting.upsert({
        where: { key: STROKE_KEY },
        create: { key: STROKE_KEY, value: JSON.stringify(input) },
        update: { value: JSON.stringify(input) }
      }),
      this.prisma.auditLog.create({
        data: { adminId, action: 'STROKE_SETTINGS_UPDATE', targetId: 'settings', metadata: { ...input } }
      })
    ]);
    return input;
  }

  /** 上传一张透明 PNG，按给定参数返回描边后的 data URL（供前端 <img> 直接预览）。 */
  async preview(source: Buffer, params: StrokeParams): Promise<{ dataUrl: string }> {
    if (!(await hasAlpha(source))) {
      throw new ApiError('UPLOAD_INVALID', '请上传透明背景的 PNG（白描边只作用于抠图结果）', HttpStatus.BAD_REQUEST);
    }
    const stroked = await addWhiteStroke(source, params);
    return { dataUrl: `data:image/png;base64,${stroked.toString('base64')}` };
  }
}
