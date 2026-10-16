import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Card, Col, Row, Select, Slider, Space, Switch, Typography, Upload } from 'antd';
import { ExperimentOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { api } from './api';

interface StrokeParams {
  ratio: number;
  baseFrequency: number;
  wobble: number;
  soften: boolean;
  down: number;
}

const DEFAULTS: StrokeParams = { ratio: 0.08, baseFrequency: 0.02, wobble: 0.3, soften: false, down: 2 };

function PreviewBox({ src, title }: { src: string; title: string }) {
  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{title}</Typography.Text>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div style={{ background: '#2b2f36', borderRadius: 8, padding: 16, textAlign: 'center', minHeight: 160 }}>
          {src ? <img src={src} alt={title} style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : <span className="muted">—</span>}
        </div>
        <div style={{ background: '#f0f0f0', borderRadius: 8, padding: 16, textAlign: 'center', minHeight: 120 }}>
          {src ? <img src={src} alt={`${title}（浅底）`} style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} /> : <span className="muted">—</span>}
        </div>
      </Space>
    </div>
  );
}

export function StrokePreviewPage() {
  const { message } = App.useApp();
  const [params, setParams] = useState<StrokeParams>(DEFAULTS);
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState('');
  const [strokedUrl, setStrokedUrl] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setParams(await api<StrokeParams>('/stroke-settings'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载参数失败');
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function onFileChange(files: UploadFile[]) {
    const picked = files[0]?.originFileObj;
    if (!picked) return;
    setFile(picked);
    setOriginalUrl(URL.createObjectURL(picked));
    setStrokedUrl('');
    setError('');
  }

  async function generate() {
    if (!file) {
      message.warning('请先上传一张透明 PNG');
      return;
    }
    setGenerating(true);
    setError('');
    try {
      const query = new URLSearchParams({
        ratio: String(params.ratio),
        baseFrequency: String(params.baseFrequency),
        wobble: String(params.wobble),
        soften: params.soften ? '1' : '0',
        down: String(params.down)
      });
      const form = new FormData();
      form.append('file', file);
      const result = await api<{ dataUrl: string }>(`/stroke-preview?${query.toString()}`, { method: 'POST', body: form });
      setStrokedUrl(result.dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      setParams(await api<StrokeParams>('/stroke-settings', { method: 'PUT', body: JSON.stringify(params) }));
      message.success('已保存，生产出图将使用新参数');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Row gutter={16}>
      <Col xs={24} lg={10}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {error && <Alert type="error" showIcon message={error} />}
          <Card title="描边参数" extra={<Button size="small" onClick={() => void load()}>重载</Button>}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div>
                <Typography.Text>粗细比例 <Typography.Text type="secondary">{params.ratio.toFixed(2)}</Typography.Text></Typography.Text>
                <Slider min={0} max={0.3} step={0.01} value={params.ratio} onChange={ratio => setParams(p => ({ ...p, ratio }))} />
              </div>
              <div>
                <Typography.Text>波浪频率 <Typography.Text type="secondary">{params.baseFrequency.toFixed(3)}</Typography.Text></Typography.Text>
                <Slider min={0.005} max={0.1} step={0.005} value={params.baseFrequency} onChange={baseFrequency => setParams(p => ({ ...p, baseFrequency }))} />
              </div>
              <div>
                <Typography.Text>起伏幅度 <Typography.Text type="secondary">{params.wobble.toFixed(2)}</Typography.Text></Typography.Text>
                <Slider min={0} max={1} step={0.05} value={params.wobble} onChange={wobble => setParams(p => ({ ...p, wobble }))} />
              </div>
              <Space>
                <Typography.Text>柔化边缘</Typography.Text>
                <Switch checked={params.soften} onChange={soften => setParams(p => ({ ...p, soften }))} />
              </Space>
              <Space>
                <Typography.Text>降采样（越小越锐利）</Typography.Text>
                <Select value={params.down} style={{ width: 80 }} onChange={down => setParams(p => ({ ...p, down }))}
                  options={[1, 2, 3, 4].map(n => ({ value: n, label: n }))} />
              </Space>
            </Space>
          </Card>

          <Card title="上传透明 PNG">
            <Upload accept="image/png,image/webp" maxCount={1} beforeUpload={() => false} onChange={({ fileList }) => onFileChange(fileList)}>
              <Button icon={<UploadOutlined />}>选择透明 PNG</Button>
            </Upload>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              白描边只作用于已抠图（带透明通道）的结果，请上传抠图后的透明 PNG。
            </Typography.Paragraph>
          </Card>

          <Space>
            <Button type="primary" icon={<ExperimentOutlined />} loading={generating} onClick={() => void generate()}>
              生成预览
            </Button>
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
              保存到生产
            </Button>
          </Space>
        </Space>
      </Col>

      <Col xs={24} lg={14}>
        <Card title="预览（上深底 / 下浅底）">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <PreviewBox src={originalUrl} title="原图" />
            </Col>
            <Col xs={24} md={12}>
              <PreviewBox src={strokedUrl} title="描边后" />
            </Col>
          </Row>
        </Card>
      </Col>
    </Row>
  );
}
