import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Image, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { api } from './api';

interface Settings { enabled: boolean; budgetBytes: number; usedBytes: number; featureFailures: number; states: Record<string, number> }
interface Sample {
  id: string; scanId?: string; userId?: string; officialBagId?: string; referenceId?: string; origin: string;
  source: string; model: string; snapshot: unknown; state: string; featureState: string; reason?: string;
  possibleDuplicate?: string; byteSize: number; url?: string; createdAt: string; expiresAt?: string;
  reviewedById?: string; reviewedAt?: string; bag?: { id: string; name: string; url?: string };
}
interface Reference { id: string; url: string }
interface CorrectionBag {
  id: string; name: string; status: string; processStatus: string;
  thumbnailUrl?: string; displayImageUrl?: string;
}
const labels: Record<string, string> = { STAGING: '保存中', STAGED: '未标记', PENDING: '待审', APPROVED: '有效参考', REJECTED: '已驳回',
  WITHDRAWN: '已撤回', REPLACED: '已替换', DELETING: '等待清理', DELETED: '照片已清理', FAILED: '保存失败', SKIPPED: '未收集' };
const reasons: Record<string, string> = { COLLECTION_DISABLED: '采集关闭', CAPACITY_FULL: '容量不足', CAPACITY_EVICTED: '容量回收',
  EXACT_DUPLICATE: '同款图片完全重复', INVALID_SAMPLE: '无法解码、空白或无主体', COS_UPLOAD_FAILED: 'COS 上传失败',
  UPLOAD_INTERRUPTED: '上传中断', FEATURE_FAILED: '特征计算失败，将重试', SAMPLE_TOO_LARGE: '压缩后超过 200KiB',
  SAMPLE_UNAVAILABLE: '没有独立样本', SAMPLE_EXPIRED: '样本过期', REFERENCE_REMOVED: '参考已移除' };
const featureLabels: Record<string, string> = { WAITING_LABEL: '等待标记', WAITING_UPLOAD: '等待图片保存', QUEUED: '等待计算', COMPUTING: '正在计算', READY: '特征就绪', FAILED: '计算失败' };
type Action = 'APPROVE' | 'REJECT' | 'CORRECT' | 'WITHDRAW' | 'RESTORE' | 'RECOMPUTE';
export function ScanSamplesPage() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Settings>();
  const [items, setItems] = useState<Sample[]>([]); const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1); const [state, setState] = useState('PENDING'); const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{ sample: Sample; action: Action }>();
  const [refs, setRefs] = useState<Reference[]>([]); const [replace, setReplace] = useState<string>();
  const [bagId, setBagId] = useState<string>(); const [bags, setBags] = useState<CorrectionBag[]>([]);
  const selectedBag = bags.find(bag => bag.id === bagId);
  const searchTimer = useRef<number | undefined>(undefined);
  const selectedImageUrl = selectedBag?.displayImageUrl ?? selectedBag?.thumbnailUrl;
  const load = useCallback(async () => {
    try {
      const [config, rows] = await Promise.all([api<Settings>('/settings/learning'), api<{ items: Sample[]; total: number }>(`/learning-samples?page=${page}&state=${state}`)]);
      setSettings(config); setItems(rows.items); setTotal(rows.total); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
  }, [page, state]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function perform(sample: Sample, action: Action, extra: object = {}) {
    setBusy(true);
    try { await api(`/learning-samples/${sample.id}/review`, { method: 'POST', body: JSON.stringify({ action, ...extra }) }); setReview(undefined); message.success('操作已保存'); await load(); }
    catch (e) { message.error(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }
  async function open(sample: Sample, action: Action) {
    setReplace(undefined); setBagId(undefined); setBags([]); setRefs([]);
    try {
      if (sample.officialBagId && action === 'RESTORE') setRefs(await api<Reference[]>(`/official-bags/${sample.officialBagId}/references`));
      if (action === 'CORRECT') void search('');
      setReview({ sample, action });
    } catch (e) { message.error(String(e)); }
  }
  async function search(search: string) {
    try {
      const result = await api<{ items: CorrectionBag[] }>(`/official-bags?search=${encodeURIComponent(search)}&pageSize=100`);
      const filtered = result.items.filter(b => b.status === 'PUBLISHED' && b.processStatus === 'READY');
      setBags(filtered);
      setBagId(prev => (prev && filtered.some(b => b.id === prev) ? prev : undefined));
    } catch (e) { message.error(String(e)); }
  }
  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {error && <Alert type="error" message={error} />}
    <Card title="扫描样本采集" extra={<Button onClick={() => void load()}>刷新</Button>}>
      <Typography.Paragraph>标记自动积累实拍照片；只有审核通过并且特征就绪的图片参与匹配。每款参考图数量不限。关闭采集后，已审核参考仍可使用。</Typography.Paragraph>
      {settings && <Space wrap>
        <span>采集开关</span><Switch checked={settings.enabled} onChange={enabled => setSettings({ ...settings, enabled })} />
        <span>COS 容量预算（GiB）</span><InputNumber min={0} max={1024} step={.25} value={settings.budgetBytes / 1024 ** 3} onChange={v => setSettings({ ...settings, budgetBytes: Math.round((v ?? 0) * 1024 ** 3) })} />
        <Button type="primary" loading={busy} onClick={async () => {
          setBusy(true); try { setSettings(await api<Settings>('/settings/learning', { method: 'PUT', body: JSON.stringify({ enabled: settings.enabled, budgetBytes: settings.budgetBytes }) })); message.success('采集设置已保存'); }
          catch (e) { message.error(String(e)); } finally { setBusy(false); }
        }}>保存</Button>
        <Tag>已占用 {(settings.usedBytes / 1024 ** 2).toFixed(2)} MiB / {(settings.budgetBytes / 1024 ** 2).toFixed(0)} MiB</Tag>
        <Tag>待审 {settings.states.PENDING ?? 0}</Tag><Tag>未收集 {settings.states.SKIPPED ?? 0} · 保存失败 {settings.states.FAILED ?? 0} · 计算失败 {settings.featureFailures}</Tag>
      </Space>}
    </Card>
    <Card title="扫描样本" extra={<Select style={{ width: 160 }} value={state} onChange={v => { setState(v); setPage(1); }} options={[{ value: '', label: '全部状态' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} />}>
      <Table<Sample> rowKey="id" dataSource={items} scroll={{ x: 1150 }} pagination={{ current: page, total, pageSize: 20, onChange: setPage }}
        expandable={{ expandedRowRender: row => <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ sampleId: row.id, scanId: row.scanId, userId: row.userId, model: row.model, snapshot: row.snapshot, bytes: row.byteSize, expiresAt: row.expiresAt, reviewedById: row.reviewedById, reviewedAt: row.reviewedAt }, null, 2)}</pre> }}
        columns={[
          { title: '用户裁剪照片', render: (_, row) => row.url ? <Image width={100} height={110} style={{ objectFit: 'contain' }} src={row.url} /> : '无照片' },
          { title: '标记款式', render: (_, row) => <Space direction="vertical">{row.bag?.url && <Image width={90} height={110} style={{ objectFit: 'contain' }} src={row.bag.url} />}<span>{row.bag?.name ?? row.officialBagId ?? '未标记'}</span></Space> },
          { title: '来源 / 时间', render: (_, row) => <>{row.source === 'camera' ? '拍照' : row.source === 'album' ? '相册' : '管理员参考'}<br />{new Date(row.createdAt).toLocaleString('zh-CN')}</> },
          { title: '状态 / 特征', render: (_, row) => <Space direction="vertical"><Tag color={row.state === 'APPROVED' ? 'green' : 'default'}>{labels[row.state] ?? row.state}</Tag><span>{featureLabels[row.featureState] ?? row.featureState}</span>{row.possibleDuplicate && <Tag color="orange">可能重复：{row.possibleDuplicate}</Tag>}<span>{row.reason ? reasons[row.reason] ?? row.reason : ''}</span></Space> },
          { title: '审核', render: (_, row) => <Space wrap>
            {row.state === 'PENDING' && <><Button size="small" type="primary" disabled={busy || row.featureState !== 'READY'} onClick={() => void perform(row, 'APPROVE')}>通过</Button><Button size="small" disabled={busy} onClick={() => void open(row, 'CORRECT')}>纠正款式</Button><Button size="small" disabled={busy} onClick={() => void open(row, 'REJECT')}>驳回</Button>{row.featureState === 'FAILED' && <Button size="small" onClick={() => void perform(row, 'RECOMPUTE')}>重算</Button>}</>}
            {row.state === 'APPROVED' && <Button size="small" danger onClick={() => void open(row, 'WITHDRAW')}>撤回</Button>}
            {['REJECTED', 'WITHDRAWN', 'REPLACED'].includes(row.state) && <><Button size="small" onClick={() => void open(row, 'RESTORE')}>恢复</Button><Button size="small" onClick={() => void open(row, 'CORRECT')}>纠正后待审</Button></>}
          </Space> }
        ]} />
    </Card>
    <Modal open={!!review} title={review ? `${({ APPROVE: '通过审核', REJECT: '驳回样本', CORRECT: '纠正对应款式', WITHDRAW: '撤回参考', RESTORE: '恢复参考', RECOMPUTE: '重新计算' })[review.action]} · ${review.sample.bag?.name ?? ''}` : ''}
      confirmLoading={busy} onCancel={() => setReview(undefined)} onOk={() => {
        if (!review) return;
        if (review.action === 'CORRECT' && !bagId) { message.warning('请选择正确款式'); return; }
        void perform(review.sample, review.action, { ...(bagId ? { bagId } : {}), ...(replace ? { replaceReferenceId: replace } : {}) });
      }}>
      {review?.action === 'CORRECT' ? <>
        <Input.Search placeholder="搜索款式或品牌，输入即搜" allowClear onSearch={v => void search(v)} onChange={e => {
          const v = e.target.value;
          window.clearTimeout(searchTimer.current);
          searchTimer.current = window.setTimeout(() => void search(v), 300);
        }} />
        <Select style={{ width: '100%', marginTop: 12 }} placeholder="选择已发布且图片就绪的款式" value={bagId} onChange={setBagId}
          showSearch optionFilterProp="label"
          virtual={false} listHeight={320}
          options={bags.map(b => ({ value: b.id, label: b.name, bag: b }))}
          optionRender={option => {
            const bag = option.data.bag;
            const url = bag.thumbnailUrl ?? bag.displayImageUrl;
            return <Space style={{ padding: '4px 0' }}>
              {url ? <Image preview={false} src={url} alt={bag.name} width={56} height={64} style={{ objectFit: 'contain' }} />
                : <Typography.Text type="secondary" style={{ display: 'inline-block', width: 56 }}>暂无图片</Typography.Text>}
              <span style={{ whiteSpace: 'normal' }}>{bag.name}</span>
            </Space>;
          }} />
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text type="secondary">用户裁剪照片</Typography.Text>
            <div style={{ marginTop: 8 }}>
              {review.sample.url ? <Image src={review.sample.url} alt="用户裁剪照片" width="100%" height={160} style={{ objectFit: 'contain' }} /> : '无照片'}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text type="secondary">{selectedBag ? '选中的正确款式' : '选择款式后查看图片'}</Typography.Text>
            {selectedBag && <div style={{ marginTop: 8 }}>
              {selectedImageUrl
                ? <Image src={selectedImageUrl} alt={selectedBag.name} width="100%" height={160} style={{ objectFit: 'contain' }} />
                : <Typography.Text type="secondary">暂无图片</Typography.Text>}
              <div style={{ marginTop: 8 }}>{selectedBag.name}</div>
            </div>}
          </div>
        </div>
      </> : <Typography.Paragraph>{review && ['WITHDRAW', 'REJECT'].includes(review.action) ? '图片保留 7 天，可在清理前恢复。' : '请确认是同款、主体清晰，并且有参考价值。恢复未就绪的驳回样本会先回到待审重新计算。'}</Typography.Paragraph>}
      {review?.action === 'RESTORE' && <>
        <Typography.Paragraph>当前额外参考：{refs.length} 张。默认新增，也可选择替换；新图和特征同时生效。</Typography.Paragraph>
        <Select allowClear style={{ width: '100%' }} placeholder="可选：选择要替换的参考图，留空则新增" value={replace} onChange={setReplace}
          options={refs.map((ref, index) => ({ value: ref.id, label: <Space><Image preview={false} src={ref.url} width={45} height={45} style={{ objectFit: 'contain' }} /><span>参考 {index + 1} · {ref.id}</span></Space> }))} />
      </>}
    </Modal>
  </Space>;
}
