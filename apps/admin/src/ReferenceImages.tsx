import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Image, Popconfirm, Space, Tag, Typography, Upload } from 'antd';
import { api } from './api';
interface Reference { id: string; url: string; models: string[] }
export function ReferenceImages({ bagId }: { bagId: string }) {
  const { message } = App.useApp(); const [items, setItems] = useState<Reference[]>([]); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await api<Reference[]>(`/official-bags/${bagId}/references`)); }
    catch (e) { message.error(e instanceof Error ? e.message : '参考图加载失败'); }
  }, [bagId, message]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function upload(file: File) {
    setBusy(true);
    try {
      const data = new FormData(); data.append('file', file);
      await api(`/official-bags/${bagId}/references`, { method: 'POST', body: data }); await load(); message.success('参考图已上传，特征正在计算');
    } catch (e) { message.error(e instanceof Error ? e.message : '上传失败'); }
    finally { setBusy(false); }
  }
  return <Card size="small" title="扫描实拍参考图" style={{ marginTop: 20 }}>
    <Typography.Paragraph type="secondary">添加已确认同款的正面、侧拍和不同光照图片；不会替换主展示图片。</Typography.Paragraph>
    <Space wrap>
      {items.map(item => <Space key={item.id} direction="vertical">
        <Image src={item.url} width={90} height={110} style={{ objectFit: 'contain' }} />
        <Tag>{item.models.length ? `已生成 ${item.models.length} 种特征` : '等待计算'}</Tag>
        <Popconfirm title="撤回这张参考图？图片保留 7 天，可在扫描样本页恢复。" onConfirm={async () => {
          try { await api(`/official-bags/${bagId}/references/${item.id}`, { method: 'DELETE' }); await load(); }
          catch (e) { message.error(String(e)); }
        }}><Button size="small" danger>撤回</Button></Popconfirm>
      </Space>)}
    </Space>
    <Space style={{ marginTop: 12 }} wrap>
      <Upload accept="image/*" showUploadList={false} beforeUpload={file => { void upload(file); return false; }} disabled={busy}>
        <Button loading={busy} disabled={busy}>添加参考图</Button>
      </Upload>
      <Button onClick={() => void load()}>刷新状态</Button>
      <Button onClick={() => void api(`/official-bags/${bagId}/references/recompute`, { method: 'POST' }).then(() => { message.success('已触发重算'); void load(); }).catch(e => message.error(String(e)))}>重新计算特征</Button>
    </Space>
  </Card>;
}
