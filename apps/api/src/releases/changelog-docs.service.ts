import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { ChangelogDocDto } from '@bagcollect/contracts';

/**
 * 仓库 docs/ 下的「改动记录」文档（后台「版本改动」页的「改动文档」页签）。
 *
 * 每次发版由 AI 把改动写成 docs 里的 md（CHANGES-*.md / UI-CHANGES-*.md），
 * 这里直接读文件返回，版本改动页无需再手工录入一遍。
 *
 * 只挑「改动记录」：文件名含 CHANGES 的 md。docs 里还有大量技术文档
 * （SCAN_MATCHING.md、IMAGE_PIPELINE.md 等），它们不是版本日志，不进列表。
 */
@Injectable()
export class ChangelogDocsService {
  list(): ChangelogDocDto[] {
    const docsDir = this.findDocsDir();
    if (!docsDir) return [];
    const files = readdirSync(docsDir).filter(
      (file) => file.toLowerCase().endsWith('.md') && file.toUpperCase().includes('CHANGES')
    );
    return files
      .map((file) => {
        const content = readFileSync(join(docsDir, file), 'utf8');
        const date = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? null;
        const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? null;
        return {
          id: file,
          date,
          title: heading ?? file.replace(/\.md$/i, ''),
          content
        } satisfies ChangelogDocDto;
      })
      .sort((a, b) => {
        if (a.date && b.date) return b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
        if (a.date) return -1;
        if (b.date) return 1;
        return b.id.localeCompare(a.id);
      });
  }

  /**
   * 从运行时 cwd 向上找 docs 目录：容器里 cwd=/app 命中 /app/docs；
   * 本地 dev（nest start 的 cwd 是 apps/api）向上到仓库根命中 docs/。
   */
  private findDocsDir(): string | null {
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(dir, 'docs');
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }
}
