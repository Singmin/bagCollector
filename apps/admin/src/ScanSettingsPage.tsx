import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Card, Form, InputNumber, Select, Space, Spin, Switch, Table, Typography } from 'antd';
interface ScanSettings {
 engine: 'color' | 'dino'; candidateThreshold: number; candidateLimit: number; visualWeight: number;
 enhancementEnabled: boolean; enhancementSkipThreshold: number; enhancementMinGap: number;
 dailyUserEnhancements: number; dailyGlobalEnhancements: number;
}
import { api } from './api';

interface Coverage { total: number; ready: number; missing: number; model: string }
interface Diagnostic { id: string; userId: string; source: string; model: string; stage: string; reason?: string; settings: ScanSettings;
  scores: { bagId: string; score: number }[]; enhancement: string; elapsedMs?: number; compared: number; feedback?: string; selectedBagId?: string; createdAt: string }
export function ScanSettingsPage() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<ScanSettings>();
  const [coverage, setCoverage] = useState<Coverage>();
  const [records, setRecords] = useState<Diagnostic[]>([]);
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [config, ready, scans] = await Promise.all([api<ScanSettings>('/settings/scan'), api<Coverage>('/settings/scan/coverage'), api<{ items: Diagnostic[]; total: number }>(`/match-scans?page=${page}`)]);
      setSettings(config); setCoverage(ready); setRecords(scans.items); setTotal(scans.total); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
  }, [page]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function save() {
    setSaving(true);
    try { setSettings(await api<ScanSettings>('/settings/scan', { method: 'PUT', body: JSON.stringify(settings) })); message.success('已保存，新扫描立即生效'); }
    catch (e) { message.error(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }
  const number = (key: keyof ScanSettings, label: string, max: number, step = 0.01, min = 0) => <Form.Item key={key} label={label}>
    <InputNumber min={min} max={max} step={step} value={settings?.[key] as number} style={{ width: '100%' }}
      onChange={value => settings && setSettings({ ...settings, [key]: value ?? min })} />
  </Form.Item>;
  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    {error && <Alert type="error" message={error} />}
    <Card title="扫描匹配设置" extra={<Button onClick={() => void load()}>刷新</Button>}>
      <Typography.Paragraph>识别结果一律由用户确认后收进收藏。扫描增强使用独立次数，不占手动抠图额度。</Typography.Paragraph>
      <Alert type="info" showIcon message={`DINOv2 主参考向量：${coverage?.ready ?? 0} / ${coverage?.total ?? 0} 就绪。参数需用实拍校准，相似度不是命中概率。`} style={{ marginBottom: 20 }} />
      {settings ? <Form layout="vertical" style={{ maxWidth: 460 }}>
        <Form.Item label="默认匹配模型"><Select value={settings.engine} onChange={engine => setSettings({ ...settings, engine })} options={[
          { value: 'color', label: '颜色模型（回滚 / 过渡）' }, { value: 'dino', label: 'DINOv2 Small（试用，向量全部就绪才允许切换）', disabled: !coverage?.total || !!coverage?.missing }
        ]} /></Form.Item>
        {number('candidateThreshold', '候选阈值', 1)}
        {number('candidateLimit', '候选数量', 10, 1, 1)}
        {number('visualWeight', '视觉特征权重（剩余权重用于颜色）', 1)}
        <Form.Item label="低置信度时增强识别"><Switch checked={settings.enhancementEnabled} onChange={enhancementEnabled => setSettings({ ...settings, enhancementEnabled })} /></Form.Item>
        {number('enhancementSkipThreshold', '增强跳过阈值', 1)}
        {number('enhancementMinGap', '跳过增强所需的第一、第二名分差', 1)}
        {number('dailyUserEnhancements', '每用户每天增强次数（0 为关闭）', 10000, 1)}
        {number('dailyGlobalEnhancements', '全站每天增强次数（0 为关闭）', 1000000, 1)}
        <Space><Button type="primary" loading={saving} onClick={() => void save()}>保存</Button>
          <Button onClick={() => void api('/match-scans/reconcile', { method: 'POST' }).then(() => message.success('已触发补算，请稍后刷新')).catch(e => message.error(String(e)))}>补算新模型向量</Button></Space>
      </Form> : <Spin />}
    </Card>
    <Card title="扫描诊断（保留 30 天）">
      <Table<Diagnostic> rowKey="id" dataSource={records} scroll={{ x: 1050 }} pagination={{ current: page, pageSize: 20, total, onChange: setPage }}
        expandable={{ expandedRowRender: record => <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ scanId: record.id, settings: record.settings, scores: record.scores, selectedBagId: record.selectedBagId }, null, 2)}</pre> }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', render: v => new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) },
          { title: '用户', dataIndex: 'userId' }, { title: '来源', dataIndex: 'source' }, { title: '模型', dataIndex: 'model' },
          { title: '状态 / 原因', render: (_, r) => `${r.stage} ${r.reason ?? ''}` }, { title: '参与款式', dataIndex: 'compared' },
          { title: '增强', dataIndex: 'enhancement' }, { title: '耗时', dataIndex: 'elapsedMs', render: v => v == null ? '—' : `${v}ms` },
          { title: '用户反馈', dataIndex: 'feedback' }
        ]} />
    </Card>
  </Space>;
}
