import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Grid,
  Image,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  Upload
} from 'antd';
import type { UploadFile } from 'antd';
import {
  DashboardOutlined,
  FileImageOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  ShoppingOutlined,
  TagsOutlined,
  UploadOutlined
} from '@ant-design/icons';

interface Overview {
  users: number;
  collectibles: number;
  failedJobs: number;
  storageBytes: number;
}

interface Job {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  errorMessage?: string;
  createdAt: string;
  collectible: { name: string };
}

interface OfficialBag {
  id: string;
  name: string;
  brandId?: string;
  brand?: string;
  notes: string;
  tags: string[];
  matting: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'OFFLINE';
  processStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  processError?: string;
  claimedCount: number;
  sortOrder: number;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  createdAt: string;
}

interface OfficialBagPage {
  items: OfficialBag[];
  nextCursor: string | null;
  totalCount: number;
}

interface Brand {
  id: string;
  name: string;
  sortOrder: number;
  bagCount: number;
  createdAt: string;
  updatedAt: string;
}

const TOKEN_KEY = 'bagcollect:admin-token';

/** 是否为手机端（< 768px），用于切换导航形态与控件宽度。 */
function useIsMobile() {
  const screens = Grid.useBreakpoint();
  return !screens.md;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || '请求失败');
  return body as T;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const statusLabels: Record<OfficialBag['status'], string> = {
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  OFFLINE: '已下架'
};

const statusColors: Record<OfficialBag['status'], string> = {
  DRAFT: 'default',
  PUBLISHED: 'green',
  OFFLINE: 'volcano'
};

const processLabels: Record<OfficialBag['processStatus'], string> = {
  PENDING: '待上传',
  PROCESSING: '处理中',
  READY: '图片就绪',
  FAILED: '处理失败'
};

const processColors: Record<OfficialBag['processStatus'], string> = {
  PENDING: 'default',
  PROCESSING: 'processing',
  READY: 'green',
  FAILED: 'red'
};

const jobStatusColors: Record<string, string> = {
  QUEUED: 'default',
  RUNNING: 'processing',
  SUCCEEDED: 'green',
  FAILED: 'red'
};

type PageKey = 'overview' | 'bags' | 'brands';

interface BagFormValues {
  name: string;
  brandId?: string | null;
  notes?: string;
  tags?: string;
  matting: boolean;
  sortOrder: number;
}

interface BrandFormValues {
  name: string;
  sortOrder: number;
}

export function App() {
  const { message, modal } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState<PageKey>('overview');
  const [bags, setBags] = useState<OfficialBag[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | OfficialBag['status']>('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<OfficialBag | 'new' | null>(null);
  const [bagEditorSession, setBagEditorSession] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [editingBrand, setEditingBrand] = useState<Brand | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextJobs] = await Promise.all([
        api<Overview>('/overview'),
        api<Job[]>('/jobs')
      ]);
      setOverview(nextOverview);
      setJobs(nextJobs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('limit', '100');
      const result = await api<OfficialBagPage>(`/official-bags?${params.toString()}`);
      setBags(result.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  const loadBrands = useCallback(async () => {
    try {
      setBrands(await api<Brand[]>('/brands'));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '品牌加载失败');
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const timer = window.setTimeout(() => {
      if (page === 'overview') void load();
      else if (page === 'bags') void loadBags();
      else void loadBrands();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [token, page, load, loadBags, loadBrands]);

  // 有图片在后台处理时轮询刷新，让「处理中 → 图片就绪」自动出现。
  useEffect(() => {
    if (!token || page !== 'bags') return;
    if (!bags.some((bag) => bag.processStatus === 'PROCESSING')) return;
    const timer = window.setInterval(() => void loadBags(), 3_000);
    return () => window.clearInterval(timer);
  }, [token, page, bags, loadBags]);

  async function login(values: { username: string; password: string }) {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ accessToken: string }>('/login', {
        method: 'POST',
        body: JSON.stringify(values)
      });
      sessionStorage.setItem(TOKEN_KEY, result.accessToken);
      setToken(result.accessToken);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  async function setBagStatus(bag: OfficialBag, status: OfficialBag['status']) {
    setError('');
    try {
      await api(`/official-bags/${bag.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      message.success(status === 'PUBLISHED' ? '已发布，发现页可见' : '已下架');
      await loadBags();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '操作失败');
    }
  }

  async function removeBag(bag: OfficialBag) {
    setError('');
    try {
      await api(`/official-bags/${bag.id}`, { method: 'DELETE' });
      message.success(`已删除「${bag.name}」`);
      await loadBags();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除失败');
    }
  }

  async function removeBrand(brand: Brand) {
    setError('');
    try {
      await api(`/brands/${brand.id}`, { method: 'DELETE' });
      message.success(`已删除品牌「${brand.name}」`);
      await loadBrands();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除失败');
    }
  }

  /**
   * 打开袋子编辑器。每次打开都换一个 session，
   * 让 BagEditor 重新挂载，避免残留上一次编辑的表单值与已选文件。
   */
  function openBagEditor(target: OfficialBag | 'new') {
    setEditing(target);
    setBagEditorSession((session) => session + 1);
  }

  /** 从品牌页跳到袋子列表并按品牌名过滤。 */
  function viewBagsOfBrand(brand: Brand) {
    setSearch(brand.name);
    setStatusFilter('');
    setPage('bags');
  }

  function logout() {
    modal.confirm({
      title: '退出登录？',
      onOk() {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
    });
  }

  if (!token) {
    return (
      <div className="login-shell">
        <Card className="login-card" title="BagCollect 管理后台">
          <Typography.Paragraph type="secondary">管理官方袋子库、云端收藏与图片处理任务。</Typography.Paragraph>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
          <Form<{ username: string; password: string }> layout="vertical" onFinish={(values) => void login(values)}>
            <Form.Item
              name="username"
              label="管理员账号"
              rules={[{ required: true, message: '请输入账号' }]}
            >
              <Input autoComplete="username" placeholder="admin" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  const menuItems = [
    { key: 'overview', icon: <DashboardOutlined />, label: '运行概览' },
    { key: 'brands', icon: <TagsOutlined />, label: '品牌管理' },
    { key: 'bags', icon: <ShoppingOutlined />, label: '官方袋子库' }
  ];

  const pageTitles: Record<PageKey, string> = {
    overview: '运行概览',
    brands: '品牌管理',
    bags: '官方袋子库'
  };

  const navMenu = (
    <Menu
      mode="inline"
      selectedKeys={[page]}
      items={menuItems}
      onClick={({ key }) => {
        setPage(key as PageKey);
        setNavOpen(false);
      }}
    />
  );

  const refresh = () => {
    if (page === 'overview') void load();
    else if (page === 'brands') void loadBrands();
    else void loadBags();
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isMobile ? (
        <Drawer
          placement="left"
          open={navOpen}
          onClose={() => setNavOpen(false)}
          width={220}
          styles={{ body: { padding: 0 } }}
          title={
            <span className="sider-brand" style={{ paddingLeft: 0 }}>
              <FileImageOutlined />
              <span>BagCollect</span>
            </span>
          }
        >
          {navMenu}
        </Drawer>
      ) : (
        <Layout.Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="light">
          <div className="sider-brand">
            <FileImageOutlined />
            {!collapsed && <span>BagCollect</span>}
          </div>
          {navMenu}
        </Layout.Sider>
      )}
      <Layout>
        <Layout.Header className="app-header">
          {isMobile && (
            <Button
              type="text"
              icon={<MenuFoldOutlined />}
              onClick={() => setNavOpen(true)}
              aria-label="打开导航"
            />
          )}
          <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
            {pageTitles[page]}
          </Typography.Title>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={refresh}
            >
              {!isMobile && '刷新'}
            </Button>
            <Button icon={<LogoutOutlined />} onClick={logout}>{!isMobile && '退出'}</Button>
          </Space>
        </Layout.Header>
        <Layout.Content className="app-content">
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

          {page === 'overview' ? (
            <OverviewPage overview={overview} jobs={jobs} loading={loading} />
          ) : page === 'brands' ? (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Typography.Text type="secondary">共 {brands.length} 个品牌</Typography.Text>
                  <Button type="primary" icon={<PlusOutlined />} block={isMobile} onClick={() => setEditingBrand('new')}>
                    新增品牌
                  </Button>
                </Space>
              </Card>
              <Card title="品牌列表">
                <Table<Brand>
                  rowKey="id"
                  dataSource={brands}
                  pagination={false}
                  scroll={{ x: 640 }}
                  columns={[
                    { title: '品牌名称', dataIndex: 'name', key: 'name', render: (name: string) => <Typography.Text strong>{name}</Typography.Text> },
                    { title: '袋子数量', dataIndex: 'bagCount', key: 'bagCount', width: 100 },
                    { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 100 },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 280,
                      render: (_, brand) => (
                        <Space size={4} wrap>
                          <Button size="small" onClick={() => setEditingBrand(brand)}>编辑</Button>
                          <Button size="small" onClick={() => viewBagsOfBrand(brand)}>查看袋子</Button>
                          <Popconfirm
                            title={`确定删除品牌「${brand.name}」？`}
                            description={brand.bagCount > 0 ? '该品牌下还有袋子，无法删除' : undefined}
                            disabled={brand.bagCount > 0}
                            onConfirm={() => void removeBrand(brand)}
                          >
                            <Button size="small" danger disabled={brand.bagCount > 0}>删除</Button>
                          </Popconfirm>
                        </Space>
                      )
                    }
                  ]}
                />
              </Card>
              <BrandEditor
                brand={editingBrand === 'new' ? null : editingBrand}
                open={editingBrand !== null}
                onClose={() => setEditingBrand(null)}
                onDone={() => {
                  setEditingBrand(null);
                  void loadBrands();
                }}
              />
            </>
          ) : (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Select<'' | OfficialBag['status']>
                    value={statusFilter}
                    onChange={setStatusFilter}
                    style={{ width: isMobile ? '100%' : 140 }}
                    options={[
                      { value: '', label: '全部状态' },
                      { value: 'DRAFT', label: '草稿' },
                      { value: 'PUBLISHED', label: '已发布' },
                      { value: 'OFFLINE', label: '已下架' }
                    ]}
                  />
                  <Input.Search
                    placeholder="搜索名称 / 品牌 / 标签"
                    allowClear
                    style={{ width: isMobile ? '100%' : 260 }}
                    onSearch={setSearch}
                    onChange={(event) => {
                      if (!event.target.value) setSearch('');
                    }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} block={isMobile} onClick={() => openBagEditor('new')}>
                    新增袋子
                  </Button>
                </Space>
              </Card>

              <Card title={`袋子列表（${bags.length} 条）`}>
                <Table<OfficialBag>
                  rowKey="id"
                  dataSource={bags}
                  loading={loading}
                  pagination={false}
                  scroll={{ x: 960 }}
                  columns={[
                    {
                      title: '图片',
                      key: 'image',
                      width: 84,
                      render: (_, bag) =>
                        bag.thumbnailUrl ? (
                          <Image src={bag.thumbnailUrl} alt={bag.name} width={56} height={56} style={{ objectFit: 'contain' }} />
                        ) : (
                          <Tag>未上传</Tag>
                        )
                    },
                    {
                      title: '名称 / 品牌',
                      key: 'name',
                      render: (_, bag) => (
                        <div>
                          <Typography.Text strong>{bag.name}</Typography.Text>
                          {bag.brand && (
                            <div>
                              <Tag
                                className="brand-tag"
                                onClick={() => {
                                  setSearch(bag.brand!);
                                  setStatusFilter('');
                                }}
                              >
                                {bag.brand}
                              </Tag>
                            </div>
                          )}
                          {bag.processError && (
                            <Typography.Text type="danger" style={{ fontSize: 12 }}>{bag.processError}</Typography.Text>
                          )}
                        </div>
                      )
                    },
                    {
                      title: '标签',
                      key: 'tags',
                      render: (_, bag) =>
                        bag.tags.length ? (
                          <Space size={4} wrap>
                            {bag.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                          </Space>
                        ) : (
                          <span className="muted">—</span>
                        )
                    },
                    {
                      title: '状态',
                      key: 'status',
                      width: 96,
                      render: (_, bag) => <Tag color={statusColors[bag.status]}>{statusLabels[bag.status]}</Tag>
                    },
                    {
                      title: '图片处理',
                      key: 'process',
                      width: 130,
                      render: (_, bag) => (
                        <Space size={4} wrap>
                          <Tag color={processColors[bag.processStatus]}>{processLabels[bag.processStatus]}</Tag>
                          {bag.matting && <Tag color="purple">抠图</Tag>}
                        </Space>
                      )
                    },
                    { title: '拥有', dataIndex: 'claimedCount', key: 'claimedCount', width: 72 },
                    { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 72 },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 260,
                      render: (_, bag) => (
                        <Space size={4} wrap>
                          <Button size="small" onClick={() => openBagEditor(bag)}>编辑</Button>
                          {bag.status !== 'PUBLISHED' && bag.processStatus === 'READY' && (
                            <Button size="small" type="primary" ghost onClick={() => void setBagStatus(bag, 'PUBLISHED')}>
                              发布
                            </Button>
                          )}
                          {bag.status === 'PUBLISHED' && (
                            <Button size="small" onClick={() => void setBagStatus(bag, 'OFFLINE')}>下架</Button>
                          )}
                          {bag.claimedCount === 0 && (
                            <Popconfirm title={`确定删除「${bag.name}」？`} description="已删除的图片无法恢复" onConfirm={() => void removeBag(bag)}>
                              <Button size="small" danger>删除</Button>
                            </Popconfirm>
                          )}
                        </Space>
                      )
                    }
                  ]}
                />
              </Card>

              <BagEditor
                key={bagEditorSession}
                bag={editing === 'new' ? null : editing}
                brands={brands}
                open={editing !== null}
                onClose={() => setEditing(null)}
                onDone={() => {
                  setEditing(null);
                  void loadBags();
                }}
                onBrandsChanged={() => void loadBrands()}
              />
            </>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function OverviewPage({ overview, jobs, loading }: { overview: Overview | null; jobs: Job[]; loading: boolean }) {
  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card><Statistic title="用户" value={overview?.users ?? 0} loading={loading && !overview} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="收藏" value={overview?.collectibles ?? 0} loading={loading && !overview} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="失败任务" value={overview?.failedJobs ?? 0} loading={loading && !overview} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="对象存储"
              value={overview ? formatBytes(overview.storageBytes) : '—'}
              loading={loading && !overview}
            />
          </Card>
        </Col>
      </Row>
      <Card title={`最近图片任务（${jobs.length} 条）`}>
        <Table<Job>
          rowKey="id"
          dataSource={jobs}
          loading={loading}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 640 }}
          columns={[
            {
              title: '收藏',
              key: 'name',
              render: (_, job) => (
                <div>
                  <Typography.Text strong>{job.collectible.name}</Typography.Text>
                  {job.errorMessage && <div className="muted">{job.errorMessage}</div>}
                </div>
              )
            },
            { title: '任务', dataIndex: 'type', key: 'type', width: 140 },
            {
              title: '状态',
              key: 'status',
              width: 110,
              render: (_, job) => <Tag color={jobStatusColors[job.status] ?? 'default'}>{job.status}</Tag>
            },
            { title: '尝试', dataIndex: 'attemptCount', key: 'attemptCount', width: 72 },
            {
              title: '时间',
              key: 'createdAt',
              width: 180,
              render: (_, job) => new Date(job.createdAt).toLocaleString('zh-CN')
            }
          ]}
        />
      </Card>
    </>
  );
}

function BagEditor({
  bag,
  brands,
  open,
  onClose,
  onDone,
  onBrandsChanged
}: {
  bag: OfficialBag | null;
  brands: Brand[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onBrandsChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<BagFormValues>();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [quickBrandOpen, setQuickBrandOpen] = useState(false);
  const [quickBrandName, setQuickBrandName] = useState('');
  const [quickBrandSaving, setQuickBrandSaving] = useState(false);

  const selectedFile = fileList[0]?.originFileObj ?? null;

  async function uploadTo(bagId: string, file: File, matting: boolean) {
    const data = new FormData();
    data.append('file', file);
    // 把当前开关一起带上：勾了抠图这次上传就按抠图处理，无需先保存表单。
    return api<{ version: number; processStatus: string }>(`/official-bags/${bagId}/image?matting=${matting}`, {
      method: 'POST',
      body: data
    });
  }

  async function save(values: BagFormValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        brandId: values.brandId ?? null,
        notes: values.notes ?? '',
        tags: values.tags ? values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : [],
        matting: values.matting,
        ...(bag ? { sortOrder: values.sortOrder } : {})
      };
      if (bag) {
        await api(`/official-bags/${bag.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const created = await api<OfficialBag>('/official-bags', { method: 'POST', body: JSON.stringify(payload) });
        // 新建后如果已经选了文件，直接上传图片。
        if (selectedFile) await uploadTo(created.id, selectedFile, values.matting ?? false);
      }
      message.success('保存成功');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function replaceImage() {
    if (!bag) return;
    if (!selectedFile) {
      message.warning('请先点击「选择图片」选一张图片');
      return;
    }
    setUploading(true);
    try {
      await uploadTo(bag.id, selectedFile, Boolean(form.getFieldValue('matting')));
      message.success('已上传，图片处理中');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  /** 删除袋子当前图片（原图与衍生图），袋子回到未上传状态；已发布袋子会自动下架。 */
  async function removeImage() {
    if (!bag) return;
    setRemoving(true);
    try {
      await api(`/official-bags/${bag.id}/image`, { method: 'DELETE' });
      message.success('图片已删除，可重新上传');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除失败');
    } finally {
      setRemoving(false);
    }
  }

  async function quickAddBrand() {
    const name = quickBrandName.trim();
    if (!name) {
      message.warning('请输入品牌名称');
      return;
    }
    setQuickBrandSaving(true);
    try {
      const created = await api<Brand>('/brands', { method: 'POST', body: JSON.stringify({ name }) });
      onBrandsChanged();
      form.setFieldValue('brandId', created.id);
      setQuickBrandOpen(false);
      setQuickBrandName('');
      message.success(`已新增品牌「${created.name}」`);
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '新增品牌失败');
    } finally {
      setQuickBrandSaving(false);
    }
  }

  return (
    <Modal
      title={bag ? `编辑：${bag.name}` : '新增袋子'}
      open={open}
      onCancel={onClose}
      width={isMobile ? '100%' : 560}
      footer={null}
      destroyOnHidden
    >
      <Form<BagFormValues>
        form={form}
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{
          name: bag?.name ?? '',
          brandId: bag?.brandId ?? null,
          notes: bag?.notes ?? '',
          tags: bag?.tags.join('，') ?? '',
          matting: bag?.matting ?? false,
          sortOrder: bag?.sortOrder ?? 0
        }}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '名称不能为空' }, { max: 80, message: '最多 80 字' }]}
        >
          <Input placeholder="例如：LV Speedy 25 老花" maxLength={80} />
        </Form.Item>
        {bag && (
          <Form.Item name="sortOrder" label="排序（数字越大越靠前）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item label="品牌">
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="brandId" noStyle>
              <Select
                placeholder="选择品牌"
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: '100%' }}
                options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
              />
            </Form.Item>
            <Button onClick={() => setQuickBrandOpen(true)}>新增品牌</Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="tags" label="标签（用逗号分隔）">
          <Input placeholder="手提包、老花、棕色" />
        </Form.Item>
        <Form.Item name="notes" label="备注" rules={[{ max: 2000 }]}>
          <Input.TextArea rows={3} placeholder="尺寸、材质、获取地点等描述" maxLength={2000} />
        </Form.Item>
        <Form.Item name="matting" label="对上传图片执行抠图" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          走腾讯云万象，0.02 元/次；不开启则仅压缩出图。
          {bag && ' 开关只作用于下一次上传：勾选后点「上传 / 替换图片」会立刻按新设置重新处理。'}
        </Typography.Paragraph>

        <Form.Item label="图片">
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Upload
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              maxCount={1}
              fileList={fileList}
              beforeUpload={() => false}
              onChange={({ fileList: next }) => setFileList(next)}
            >
              <Button icon={<UploadOutlined />}>选择图片</Button>
            </Upload>
            {bag?.thumbnailUrl && (
              <Space size={12} align="center">
                <Image src={bag.thumbnailUrl} alt={bag.name} width={96} style={{ objectFit: 'contain' }} />
                <Popconfirm
                  title="删除这张图片？"
                  description="删除后袋子回到未上传状态；已发布的袋子会自动下架。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removeImage()}
                >
                  <Button danger size="small" loading={removing} disabled={bag.claimedCount > 0}>
                    删除图片
                  </Button>
                </Popconfirm>
              </Space>
            )}
            {bag && (
              <Button onClick={() => void replaceImage()} loading={uploading} disabled={bag.claimedCount > 0}>
                {bag.claimedCount > 0 ? '已被拥有，不能换图 / 删图' : '上传 / 替换图片'}
              </Button>
            )}
            {!bag && <Typography.Text type="secondary">新建保存后，如已选择图片将自动上传并开始处理。</Typography.Text>}
          </Space>
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving || uploading}>保存</Button>
          </Space>
        </Form.Item>
      </Form>

      <Modal
        title="快速新增品牌"
        open={quickBrandOpen}
        onCancel={() => setQuickBrandOpen(false)}
        onOk={() => void quickAddBrand()}
        confirmLoading={quickBrandSaving}
        okText="新增"
        destroyOnHidden
      >
        <Input
          placeholder="品牌名称，例如：Louis Vuitton"
          value={quickBrandName}
          maxLength={80}
          onChange={(event) => setQuickBrandName(event.target.value)}
          onPressEnter={() => void quickAddBrand()}
        />
      </Modal>
    </Modal>
  );
}

function BrandEditor({
  brand,
  open,
  onClose,
  onDone
}: {
  brand: Brand | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [saving, setSaving] = useState(false);

  async function save(values: BrandFormValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        ...(brand ? { sortOrder: values.sortOrder } : {})
      };
      if (brand) {
        await api(`/brands/${brand.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/brands', { method: 'POST', body: JSON.stringify(payload) });
      }
      message.success('保存成功');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={brand ? `编辑品牌：${brand.name}` : '新增品牌'}
      open={open}
      onCancel={onClose}
      width={isMobile ? '100%' : 520}
      footer={null}
      destroyOnHidden
    >
      <Form<BrandFormValues>
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{ name: brand?.name ?? '', sortOrder: brand?.sortOrder ?? 0 }}
      >
        <Form.Item
          name="name"
          label="品牌名称"
          rules={[{ required: true, message: '品牌名不能为空' }, { max: 80, message: '最多 80 字' }]}
        >
          <Input placeholder="例如：Louis Vuitton" maxLength={80} />
        </Form.Item>
        {brand && (
          <Form.Item name="sortOrder" label="排序（数字越大越靠前）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}
