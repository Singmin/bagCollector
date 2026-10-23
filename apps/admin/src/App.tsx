import type { ImageSide, ImageSideDto } from '../../../packages/contracts/src/image-sides';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
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
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload
} from 'antd';
import type { UploadFile } from 'antd';
import * as XLSX from 'xlsx';
import {
  AuditOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileImageOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  ShoppingOutlined,
  TagsOutlined,
  TeamOutlined,
  UploadOutlined
} from '@ant-design/icons';
import { api, TOKEN_KEY } from './api';
import { ClaimStats } from './ClaimStats';
import { ChangelogPage } from './ChangelogPage';
import { ScanSettingsPage } from './ScanSettingsPage';
import { ScanSamplesPage } from './ScanSamplesPage';
import { ReferenceImages } from './ReferenceImages';
import { StrokePreviewPage } from './StrokePreviewPage';

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
  sides?: Partial<Record<ImageSide, ImageSideDto>>;
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
  hasEmbedding?: boolean;
  createdAt: string;
}

interface OfficialBagPage {
  items: OfficialBag[];
  nextCursor: string | null;
  totalCount: number;
}

type BagSortField = 'sortOrder' | 'name' | 'createdAt' | 'claimedCount';

interface Brand {
  id: string;
  name: string;
  sortOrder: number;
  displayImageUrl?: string;
  bagCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Submission {
  sides?: Partial<Record<ImageSide, ImageSideDto>>;
  id: string;
  name: string;
  notes: string;
  tags: string[];
  userId: string;
  shelfName: string;
  processingStatus: string;
  submissionStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewNote?: string;
  promotedBagId?: string;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  hasCutout: boolean;
  byteSize: number;
  addedAt: string;
  reviewedAt?: string;
}

interface SubmissionPage {
  items: Submission[];
  totalCount: number;
}

interface AdminUser {
  id: string;
  openidMasked: string;
  hasUnionid: boolean;
  status: 'ACTIVE' | 'SUSPENDED';
  collectibleCount: number;
  shelfCount: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  lastLoginAt: string;
  createdAt: string;
}

interface AdminUserPage {
  items: AdminUser[];
  totalCount: number;
}

interface AdminUserDetail extends AdminUser {
  unionid?: string;
  collectibleQuota: number;
  dailyMattingQuota: number;
  recentCollectibles: {
    id: string;
    name: string;
    shelfName: string;
    processingStatus: string;
    addedAt: string;
  }[];
}

interface AuditLog {
  id: string;
  action: string;
  targetId?: string;
  adminId?: string;
  adminUsername?: string;
  userId?: string;
  metadata?: unknown;
  createdAt: string;
}

interface AuditLogPage {
  items: AuditLog[];
  totalCount: number;
}

interface JobPage {
  items: Job[];
  totalCount: number;
}

/** 是否为手机端（< 768px），用于切换导航形态与控件宽度。 */
function useIsMobile() {
  const screens = Grid.useBreakpoint();
  return !screens.md;
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

const submissionStatusLabels: Record<Submission['submissionStatus'], string> = {
  PENDING: '待审核',
  APPROVED: '已纳入',
  REJECTED: '已驳回'
};

const submissionStatusColors: Record<Submission['submissionStatus'], string> = {
  PENDING: 'gold',
  APPROVED: 'green',
  REJECTED: 'volcano'
};

const userStatusLabels: Record<AdminUser['status'], string> = {
  ACTIVE: '正常',
  SUSPENDED: '已封禁'
};

const userStatusColors: Record<AdminUser['status'], string> = {
  ACTIVE: 'green',
  SUSPENDED: 'red'
};

/** 列表上的处理进度分档。三档展开成具体状态的事在服务端做，见 submissions-admin.service。 */
type ProcessFilter = 'ALL' | 'READY' | 'PROCESSING' | 'FAILED';

type PageKey = 'overview' | 'bags' | 'brands' | 'submissions' | 'users' | 'audit' | 'match' | 'samples' | 'changelog' | 'stroke';

/** 拍照扫描袋子的判定阈值（存库、后台可改、保存即生效）。 */


interface BagFormValues {
  name: string;
  brandId?: string | null;
  notes?: string;
  tags?: string;
  sortOrder: number;
}

interface BrandFormValues {
  name: string;
  sortOrder: number;
}

/** Excel 导入：可映射到袋子上的字段。 */
type ImportField = 'name' | 'brandName' | 'tags' | 'notes';

interface ImportBagRow {
  name: string;
  brandName?: string;
  notes?: string;
  tags?: string[];
}

export function App() {
  const { message, modal } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobPage, setJobPage] = useState(1);
  const [jobPageSize, setJobPageSize] = useState(20);
  const [jobTotal, setJobTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState<PageKey>('overview');
  const [bags, setBags] = useState<OfficialBag[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | OfficialBag['status']>('');
  const [search, setSearch] = useState('');
  const [bagPage, setBagPage] = useState(1);
  const [bagPageSize, setBagPageSize] = useState(20);
  const [bagTotal, setBagTotal] = useState(0);
  const [bagSort, setBagSort] = useState<BagSortField>('sortOrder');
  const [bagOrder, setBagOrder] = useState<'asc' | 'desc'>('desc');
  const [editing, setEditing] = useState<OfficialBag | 'new' | null>(null);
  const [bagEditorSession, setBagEditorSession] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  /** 手动补算官方袋子视觉向量（拍照扫描匹配用）的进行中状态 */
  const [reconciling, setReconciling] = useState(false);
  /** 扫描匹配的判定阈值（null = 还没加载出来） */
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  /** 版本改动页的刷新：自增 key 强制重挂载，让页面重新拉取数据。 */
  const [changelogRefreshKey, setChangelogRefreshKey] = useState(0);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandSearch, setBrandSearch] = useState('');
  const [editingBrand, setEditingBrand] = useState<Brand | 'new' | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [submissionStatusFilter, setSubmissionStatusFilter] = useState<'' | Submission['submissionStatus']>('');
  const [submissionSearch, setSubmissionSearch] = useState('');
  const [submissionDateRange, setSubmissionDateRange] = useState<[string, string] | null>(null);
  const [submissionPage, setSubmissionPage] = useState(1);
  const [submissionPageSize, setSubmissionPageSize] = useState(20);
  const [submissionTotal, setSubmissionTotal] = useState(0);
  /* 服务端排序：sort/order 传给 /submissions 接口，全量口径排序后分页（不再前端本页排） */
  const [submissionSort, setSubmissionSort] = useState<'name' | 'byteSize' | 'addedAt'>();
  const [submissionOrder, setSubmissionOrder] = useState<'asc' | 'desc'>();
  const [promoting, setPromoting] = useState<Submission | null>(null);
  const [rejecting, setRejecting] = useState<Submission | null>(null);
  const [processFilter, setProcessFilter] = useState<ProcessFilter>('ALL');
  /** 用户上传审核页的子页签：uploads = 用户上传，claims = 认领收藏。 */
  const [submissionTab, setSubmissionTab] = useState('uploads');
  /** 认领收藏页签的刷新：自增 key 强制重挂载，让组件重新拉取数据。 */
  const [claimsRefreshKey, setClaimsRefreshKey] = useState(0);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userStatusFilter, setUserStatusFilter] = useState<'' | AdminUser['status']>('');
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(20);
  const [userTotal, setUserTotal] = useState(0);
  const [userSort, setUserSort] = useState<'collectibleCount' | 'shelfCount' | 'storageUsedBytes' | 'lastLoginAt'>();
  const [userOrder, setUserOrder] = useState<'asc' | 'desc'>();
  const [userDetail, setUserDetail] = useState<AdminUserDetail | null>(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [editingQuotaUser, setEditingQuotaUser] = useState<AdminUserDetail | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditAction, setAuditAction] = useState('');
  const [auditDateRange, setAuditDateRange] = useState<[string, string] | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize, setAuditPageSize] = useState(50);
  const [auditOrder, setAuditOrder] = useState<'asc' | 'desc'>();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextJobs] = await Promise.all([
        api<Overview>('/overview'),
        api<JobPage>(`/jobs?page=${jobPage}&pageSize=${jobPageSize}`)
      ]);
      setOverview(nextOverview);
      setJobs(nextJobs.items);
      setJobTotal(nextJobs.totalCount);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [jobPage, jobPageSize]);

  const loadBags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('page', String(bagPage));
      params.set('pageSize', String(bagPageSize));
      params.set('sort', bagSort);
      params.set('order', bagOrder);
      const result = await api<OfficialBagPage>(`/official-bags?${params.toString()}`);
      setBags(result.items);
      setBagTotal(result.totalCount);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, bagPage, bagPageSize, bagSort, bagOrder]);

  const loadBrands = useCallback(async () => {
    try {
      setBrands(await api<Brand[]>('/brands'));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '品牌加载失败');
    }
  }, []);

  const loadSubmissions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (submissionStatusFilter) params.set('status', submissionStatusFilter);
      if (submissionSearch.trim()) params.set('search', submissionSearch.trim());
      if (submissionDateRange) {
        params.set('from', submissionDateRange[0]);
        params.set('to', submissionDateRange[1]);
      }
      /* 处理状态筛选也交给服务端：分页之后再做客户端过滤只能过滤当前页，
         「只看失败」会变成「只看当前页里失败的」—— 那是错的。 */
      if (processFilter !== 'ALL') params.set('process', processFilter);
      if (submissionSort) {
        params.set('sort', submissionSort);
        params.set('order', submissionOrder ?? 'desc');
      }
      params.set('page', String(submissionPage));
      params.set('pageSize', String(submissionPageSize));
      const result = await api<SubmissionPage>(`/submissions?${params.toString()}`);
      setSubmissions(result.items);
      setSubmissionTotal(result.totalCount);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [submissionStatusFilter, submissionSearch, submissionDateRange, processFilter, submissionPage, submissionPageSize, submissionSort, submissionOrder]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (userStatusFilter) params.set('status', userStatusFilter);
      if (userSearch.trim()) params.set('search', userSearch.trim());
      if (userSort) {
        params.set('sort', userSort);
        params.set('order', userOrder ?? 'desc');
      }
      params.set('page', String(userPage));
      params.set('pageSize', String(userPageSize));
      const result = await api<AdminUserPage>(`/users?${params.toString()}`);
      setUsers(result.items);
      setUserTotal(result.totalCount);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [userStatusFilter, userSearch, userPage, userPageSize, userSort, userOrder]);

  const loadAuditLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (auditAction.trim()) params.set('action', auditAction.trim());
      if (auditDateRange) {
        params.set('from', auditDateRange[0]);
        params.set('to', auditDateRange[1]);
      }
      if (auditOrder) params.set('order', auditOrder);
      params.set('page', String(auditPage));
      params.set('pageSize', String(auditPageSize));
      const result = await api<AuditLogPage>(`/audit-logs?${params.toString()}`);
      setAuditLogs(result.items);
      setAuditTotal(result.totalCount);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [auditAction, auditDateRange, auditPage, auditPageSize, auditOrder]);

  const openUserDetail = useCallback(async (id: string): Promise<AdminUserDetail | null> => {
    setUserDetailLoading(true);
    try {
      const detail = await api<AdminUserDetail>(`/users/${id}`);
      setUserDetail(detail);
      return detail;
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '加载用户详情失败');
      return null;
    } finally {
      setUserDetailLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!token) return;
    const timer = window.setTimeout(() => {
      if (page === 'overview') void load();
      else if (page === 'bags') void loadBags();
      else if (page === 'submissions') void loadSubmissions();
      else if (page === 'users') void loadUsers();
      else if (page === 'audit') void loadAuditLogs();
      else if (page === 'match') setChangelogRefreshKey(key => key + 1);
      else if (page === 'changelog') {
        // 版本改动页自己管理数据加载，这里不触发任何主组件的 load。
      }
      else void loadBrands();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [token, page, load, loadBags, loadBrands, loadSubmissions, loadUsers, loadAuditLogs]);

  // 有图片在后台处理时轮询刷新，让「处理中 → 图片就绪」自动出现。
  useEffect(() => {
    if (!token || page !== 'bags') return;
    if (!bags.some((bag) => bag.processStatus === 'PROCESSING' || Object.values(bag.sides ?? {}).some(side => side.processingStatus === 'PROCESSING'))) return;
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

  /**
   * 手动补算官方袋子的视觉向量（拍照扫描匹配用）。
   *
   * 正常情况下不需要点它：上传/重传图片时 worker 会顺手算好，漏掉的也会被定时对账补上。
   * 这个按钮是给「刚纳入 / 刚上传完，想立刻能被扫到」这种时刻用的 —— 不必等下一轮对账。
   * 补算在 worker 里跑（要下载解码图片、做像素计算，是 CPU 活），这里只负责触发。
   */
  async function reconcileEmbeddings() {
    setError('');
    setReconciling(true);
    try {
      const result = await api<{ queued: boolean; pending: number }>('/official-bags/embeddings/reconcile', {
        method: 'POST'
      });
      message.success(
        result.pending > 0
          ? `发现 ${result.pending} 个袋子缺少向量，已提交后台补算`
          : '没有发现缺少向量的袋子，已提交全量核对'
      );
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '触发补算失败');
    } finally {
      setReconciling(false);
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

  async function reopenSubmission(submission: Submission) {
    setError('');
    try {
      await api(`/submissions/${submission.id}/reopen`, { method: 'POST' });
      message.success('已重新打开审核');
      await loadSubmissions();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '操作失败');
    }
  }

  async function setUserStatus(id: string, status: AdminUser['status']) {
    setError('');
    try {
      await api(`/users/${id}/${status === 'SUSPENDED' ? 'suspend' : 'activate'}`, { method: 'POST' });
      message.success(status === 'SUSPENDED' ? '已封禁该用户' : '已解封该用户');
      await loadUsers();
      if (userDetail?.id === id) await openUserDetail(id);
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '操作失败');
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
    setBagPage(1);
    setPage('bags');
  }

  /** 按关键字过滤品牌（前端过滤，品牌总量小无需走接口）。 */
  const filteredBrands = useMemo(() => {
    const keyword = brandSearch.trim().toLowerCase();
    if (!keyword) return brands;
    return brands.filter((brand) => brand.name.toLowerCase().includes(keyword));
  }, [brands, brandSearch]);

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
    { key: 'bags', icon: <ShoppingOutlined />, label: '官方袋子库' },
    { key: 'submissions', icon: <FileImageOutlined />, label: '用户上传审核' },
    { key: 'users', icon: <TeamOutlined />, label: '用户管理' },
    { key: 'audit', icon: <AuditOutlined />, label: '审计日志' },
    { key: 'match', icon: <SettingOutlined />, label: '匹配设置' },
    { key: 'samples', icon: <FileImageOutlined />, label: '扫描样本' },
    { key: 'stroke', icon: <ExperimentOutlined />, label: '描边预览' },
    { key: 'changelog', icon: <HistoryOutlined />, label: '版本改动' }
  ];

  const pageTitles: Record<PageKey, string> = {
    overview: '运行概览',
    brands: '品牌管理',
    bags: '官方袋子库',
    submissions: '用户上传审核',
    users: '用户管理',
    audit: '审计日志',
    match: '匹配设置',
    samples: '扫描样本',
    stroke: '描边预览',
    changelog: '版本改动'
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
    else if (page === 'submissions') {
      if (submissionTab === 'claims') setClaimsRefreshKey((key) => key + 1);
      else void loadSubmissions();
    }
    else if (page === 'users') void loadUsers();
    else if (page === 'audit') void loadAuditLogs();
    else if (page === 'match') setChangelogRefreshKey(key => key + 1);
    else if (page === 'changelog') setChangelogRefreshKey((key) => key + 1);
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
          <Space size={12} align="center">
            <BuildMeta />
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

          {page === 'changelog' ? (
            <ChangelogPage key={changelogRefreshKey} />
          ) : page === 'overview' ? (
            <OverviewPage
              overview={overview}
              jobs={jobs}
              loading={loading}
              jobPage={jobPage}
              jobPageSize={jobPageSize}
              jobTotal={jobTotal}
              onJobPageChange={(nextPage, nextPageSize) => {
                setJobPage(nextPageSize === jobPageSize ? nextPage : 1);
                setJobPageSize(nextPageSize);
              }}
            />
          ) : page === 'match' ? (
            <ScanSettingsPage key={changelogRefreshKey} />
          ) : page === 'samples' ? (
            <ScanSamplesPage key={changelogRefreshKey} />
          ) : page === 'stroke' ? (
            <StrokePreviewPage />
          ) : page === 'brands' ? (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Typography.Text type="secondary">共 {brands.length} 个品牌</Typography.Text>
                  <Button type="primary" icon={<PlusOutlined />} block={isMobile} onClick={() => setEditingBrand('new')}>
                    新增品牌
                  </Button>
                  <Input
                    allowClear
                    prefix={<SearchOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />}
                    placeholder="搜索品牌名称"
                    style={{ width: isMobile ? '100%' : 220 }}
                    value={brandSearch}
                    onChange={(e) => setBrandSearch(e.target.value)}
                  />
                </Space>
              </Card>
              <Card title={`品牌列表（共 ${filteredBrands.length} 个）`}>
                <Table<Brand>
                  rowKey="id"
                  dataSource={filteredBrands}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 个` }}
                  scroll={{ x: 640 }}
                  columns={[
                    {
                      title: '展示图',
                      dataIndex: 'displayImageUrl',
                      key: 'displayImageUrl',
                      width: 90,
                      render: (url?: string) => url
                        ? <Image src={url} width={48} height={48} style={{ objectFit: 'cover', borderRadius: 4 }} />
                        : <Typography.Text type="secondary">—</Typography.Text>
                    },
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
          ) : page === 'submissions' ? (
            <Tabs
              activeKey={submissionTab}
              onChange={setSubmissionTab}
              items={[
                {
                  key: 'uploads',
                  label: '用户上传',
                  children: (
                    <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Select<'' | Submission['submissionStatus']>
                    value={submissionStatusFilter}
                    onChange={(value) => {
                      setSubmissionStatusFilter(value);
                      setSubmissionPage(1);
                    }}
                    style={{ width: isMobile ? '100%' : 140 }}
                    options={[
                      { value: '', label: '全部状态' },
                      { value: 'PENDING', label: '待审核' },
                      { value: 'APPROVED', label: '已纳入' },
                      { value: 'REJECTED', label: '已驳回' }
                    ]}
                  />
                  <Select<ProcessFilter>
                    value={processFilter}
                    onChange={(value) => {
                      setProcessFilter(value);
                      setSubmissionPage(1);
                    }}
                    style={{ width: isMobile ? '100%' : 140 }}
                    options={[
                      { value: 'ALL', label: '全部图片' },
                      { value: 'READY', label: '就绪' },
                      { value: 'PROCESSING', label: '处理中' },
                      { value: 'FAILED', label: '失败' }
                    ]}
                  />
                  <DatePicker.RangePicker
                    format="YYYY-MM-DD"
                    placeholder={['开始日期', '结束日期']}
                    style={{ width: isMobile ? '100%' : 260 }}
                    onChange={(dates, dateStrings) => {
                      if (dates && dates[0] && dates[1]) {
                        setSubmissionDateRange([dateStrings[0], dateStrings[1]]);
                      } else {
                        setSubmissionDateRange(null);
                      }
                      setSubmissionPage(1);
                    }}
                  />
                  <Input.Search
                    placeholder="搜索名称 / 标签 / 展示架"
                    allowClear
                    style={{ width: isMobile ? '100%' : 260 }}
                    onSearch={(value) => {
                      setSubmissionSearch(value);
                      setSubmissionPage(1);
                    }}
                    onChange={(event) => {
                      if (!event.target.value) setSubmissionSearch('');
                    }}
                  />
                </Space>
              </Card>

              <Card title={`用户上传（共 ${submissionTotal} 条）`}>
                <Table<Submission>
                  rowKey="id"
                  dataSource={submissions}
                  loading={loading}
                  pagination={{
                    current: submissionPage,
                    pageSize: submissionPageSize,
                    total: submissionTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (nextPage, nextPageSize) => {
                      setSubmissionPage(nextPageSize === submissionPageSize ? nextPage : 1);
                      setSubmissionPageSize(nextPageSize);
                    }
                  }}
                  scroll={{ x: 1100 }}
                  onChange={(_, _filters, sorter, extra) => {
                    /* 排序交给服务端：仅响应排序动作（分页走 pagination.onChange，互不干扰） */
                    if (extra.action !== 'sort') return;
                    const active = Array.isArray(sorter) ? sorter[0] : sorter;
                    const key = active?.columnKey;
                    if (!active?.order || (key !== 'name' && key !== 'byteSize' && key !== 'addedAt')) {
                      setSubmissionSort(undefined);
                      setSubmissionOrder(undefined);
                    } else {
                      setSubmissionSort(key);
                      setSubmissionOrder(active.order === 'ascend' ? 'asc' : 'desc');
                    }
                    setSubmissionPage(1);
                  }}
                  columns={[
                    {
                      title: '图片',
                      key: 'image',
                      width: 84,
                      render: (_, sub) =>
                        sub.thumbnailUrl ? (
                          <Image.PreviewGroup><Space><Image src={sub.displayImageUrl ?? sub.thumbnailUrl} alt={`${sub.name} · 正面`} width={56} height={56} style={{ objectFit: 'contain' }} />{sub.sides?.BACK?.displayImageUrl && <Image src={sub.sides.BACK.displayImageUrl} alt={`${sub.name} · 反面`} width={56} height={56} style={{ objectFit: 'contain' }} />}</Space></Image.PreviewGroup>
                        ) : (
                          <Tag>未处理</Tag>
                        )
                    },
                    {
                      title: '名称',
                      key: 'name',
                      sorter: true,
                      sortOrder: submissionSort === 'name' ? (submissionOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, sub) => (
                        <div>
                          <Typography.Text strong>{sub.name}</Typography.Text>
                          <div className="muted" style={{ fontSize: 12 }}>展示架：{sub.shelfName}</div>
                          {sub.reviewNote && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>意见：{sub.reviewNote}</Typography.Text>
                          )}
                        </div>
                      )
                    },
                    {
                      title: '标签',
                      key: 'tags',
                      render: (_, sub) =>
                        sub.tags.length ? (
                          <Space size={4} wrap>
                            {sub.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                          </Space>
                        ) : (
                          <span className="muted">—</span>
                        )
                    },
                    {
                      title: '审核状态',
                      key: 'submissionStatus',
                      width: 96,
                      render: (_, sub) => (
                        <Tag color={submissionStatusColors[sub.submissionStatus]}>
                          {submissionStatusLabels[sub.submissionStatus]}
                        </Tag>
                      )
                    },
                    {
                      title: '图片处理',
                      key: 'process',
                      width: 130,
                      render: (_, sub) => (
                        <Space size={4} wrap>
                          <Tag color={sub.processingStatus === 'READY' ? 'green' : 'default'}>
                            {sub.processingStatus === 'READY' ? '就绪' : sub.processingStatus}
                          </Tag>
                          {sub.hasCutout && <Tag color="purple">抠图</Tag>}
                        </Space>
                      )
                    },
                    {
                      title: '图片大小',
                      key: 'byteSize',
                      width: 110,
                      sorter: true,
                      sortOrder: submissionSort === 'byteSize' ? (submissionOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, sub) => (sub.byteSize > 0 ? formatBytes(sub.byteSize) : <span className="muted">—</span>)
                    },
                    {
                      title: '上传时间',
                      key: 'addedAt',
                      width: 170,
                      sorter: true,
                      sortOrder: submissionSort === 'addedAt' ? (submissionOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, sub) => new Date(sub.addedAt).toLocaleString('zh-CN')
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 220,
                      render: (_, sub) => (
                        <Space size={4} wrap>
                          {!sub.promotedBagId && (
                            <Button size="small" type="primary" ghost onClick={() => setPromoting(sub)}>
                              纳入官方
                            </Button>
                          )}
                          {sub.submissionStatus === 'PENDING' && !sub.promotedBagId && (
                            <Button size="small" onClick={() => setRejecting(sub)}>驳回</Button>
                          )}
                          {sub.submissionStatus === 'REJECTED' && !sub.promotedBagId && (
                            <Button size="small" onClick={() => void reopenSubmission(sub)}>重新审核</Button>
                          )}
                          {sub.promotedBagId && <Tag color="green">已纳入</Tag>}
                        </Space>
                      )
                    }
                  ]}
                />
              </Card>

              <PromoteSubmissionModal
                submission={promoting}
                brands={brands}
                onClose={() => setPromoting(null)}
                onDone={() => {
                  setPromoting(null);
                  void loadSubmissions();
                }}
              />
              <RejectSubmissionModal
                submission={rejecting}
                onClose={() => setRejecting(null)}
                onDone={() => {
                  setRejecting(null);
                  void loadSubmissions();
                }}
              />
                    </>
                  )
                },
                {
                  key: 'claims',
                  label: '认领收藏',
                  children: <ClaimStats key={claimsRefreshKey} />
                }
              ]}
            />
          ) : page === 'users' ? (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Select<'' | AdminUser['status']>
                    value={userStatusFilter}
                    onChange={(value) => {
                      setUserStatusFilter(value);
                      setUserPage(1);
                    }}
                    style={{ width: isMobile ? '100%' : 140 }}
                    options={[
                      { value: '', label: '全部状态' },
                      { value: 'ACTIVE', label: '正常' },
                      { value: 'SUSPENDED', label: '已封禁' }
                    ]}
                  />
                  <Input.Search
                    placeholder="搜索 openid / unionid"
                    allowClear
                    style={{ width: isMobile ? '100%' : 260 }}
                    onSearch={(value) => {
                      setUserSearch(value);
                      setUserPage(1);
                    }}
                    onChange={(event) => {
                      if (!event.target.value) setUserSearch('');
                    }}
                  />
                </Space>
              </Card>

              <Card title={`用户（共 ${userTotal} 条）`}>
                <Table<AdminUser>
                  rowKey="id"
                  dataSource={users}
                  loading={loading}
                  pagination={{
                    current: userPage,
                    pageSize: userPageSize,
                    total: userTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (nextPage, nextPageSize) => {
                      setUserPage(nextPageSize !== userPageSize ? 1 : nextPage);
                      setUserPageSize(nextPageSize);
                    }
                  }}
                  scroll={{ x: 1080 }}
                  onChange={(_, _filters, sorter, extra) => {
                    if (extra.action !== 'sort') return;
                    const active = Array.isArray(sorter) ? sorter[0] : sorter;
                    const key = active?.columnKey;
                    if (!active?.order || (key !== 'collectibleCount' && key !== 'shelfCount' && key !== 'storageUsedBytes' && key !== 'lastLoginAt')) {
                      setUserSort(undefined);
                      setUserOrder(undefined);
                    } else {
                      setUserSort(key as 'collectibleCount' | 'shelfCount' | 'storageUsedBytes' | 'lastLoginAt');
                      setUserOrder(active.order === 'ascend' ? 'asc' : 'desc');
                    }
                    setUserPage(1);
                  }}
                  columns={[
                    {
                      title: '用户标识',
                      key: 'openid',
                      render: (_, user) => (
                        <div>
                          <Typography.Text strong>{user.openidMasked}</Typography.Text>
                          {user.hasUnionid && <Tag style={{ marginLeft: 8 }}>有 unionid</Tag>}
                        </div>
                      )
                    },
                    {
                      title: '状态',
                      key: 'status',
                      width: 96,
                      render: (_, user) => <Tag color={userStatusColors[user.status]}>{userStatusLabels[user.status]}</Tag>
                    },
                    {
                      title: '收藏',
                      dataIndex: 'collectibleCount',
                      key: 'collectibleCount',
                      width: 80,
                      sorter: true,
                      sortOrder: userSort === 'collectibleCount' ? (userOrder === 'asc' ? 'ascend' : 'descend') : null
                    },
                    {
                      title: '架子',
                      dataIndex: 'shelfCount',
                      key: 'shelfCount',
                      width: 80,
                      sorter: true,
                      sortOrder: userSort === 'shelfCount' ? (userOrder === 'asc' ? 'ascend' : 'descend') : null
                    },
                    {
                      title: '存储用量',
                      key: 'storageUsedBytes',
                      width: 150,
                      sorter: true,
                      sortOrder: userSort === 'storageUsedBytes' ? (userOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, user) => (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageQuotaBytes)}
                        </Typography.Text>
                      )
                    },
                    {
                      title: '最近登录',
                      dataIndex: 'lastLoginAt',
                      key: 'lastLoginAt',
                      width: 170,
                      sorter: true,
                      sortOrder: userSort === 'lastLoginAt' ? (userOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, user) => new Date(user.lastLoginAt).toLocaleString('zh-CN')
                    },
                    {
                      title: '注册时间',
                      dataIndex: 'createdAt',
                      key: 'createdAt',
                      width: 170,
                      render: (_, user) => new Date(user.createdAt).toLocaleString('zh-CN')
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 220,
                      render: (_, user) => (
                        <Space size={4} wrap>
                          <Button size="small" onClick={() => void openUserDetail(user.id)}>详情</Button>
                          <Button
                            size="small"
                            onClick={() => {
                              void openUserDetail(user.id).then((detail) => {
                                if (detail) setEditingQuotaUser(detail);
                              });
                            }}
                          >
                            配额
                          </Button>
                          {user.status === 'ACTIVE' ? (
                            <Popconfirm
                              title={`确定封禁该用户？`}
                              description="封禁后将撤销其全部登录会话"
                              okText="封禁"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => void setUserStatus(user.id, 'SUSPENDED')}
                            >
                              <Button size="small" danger>封禁</Button>
                            </Popconfirm>
                          ) : (
                            <Button size="small" onClick={() => void setUserStatus(user.id, 'ACTIVE')}>解封</Button>
                          )}
                        </Space>
                      )
                    }
                  ]}
                />
              </Card>

              <UserDetailDrawer
                user={userDetail}
                loading={userDetailLoading}
                onClose={() => setUserDetail(null)}
                onEditQuota={() => setEditingQuotaUser(userDetail)}
                onToggleStatus={(status) => {
                  if (userDetail) void setUserStatus(userDetail.id, status);
                }}
              />
              <UserQuotaModal
                user={editingQuotaUser}
                onClose={() => setEditingQuotaUser(null)}
                onDone={async (updated) => {
                  setEditingQuotaUser(null);
                  await loadUsers();
                  if (userDetail?.id === updated.id) void openUserDetail(updated.id);
                }}
              />
            </>
          ) : page === 'audit' ? (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Input.Search
                    placeholder="搜索动作（如 USER / SUBMISSION）"
                    allowClear
                    style={{ width: isMobile ? '100%' : 280 }}
                    onSearch={(value) => {
                      setAuditAction(value);
                      setAuditPage(1);
                    }}
                    onChange={(event) => {
                      if (!event.target.value) setAuditAction('');
                    }}
                  />
                  <DatePicker.RangePicker
                    format="YYYY-MM-DD"
                    placeholder={['开始日期', '结束日期']}
                    style={{ width: isMobile ? '100%' : 260 }}
                    onChange={(dates, dateStrings) => {
                      if (dates && dates[0] && dates[1]) {
                        setAuditDateRange([dateStrings[0], dateStrings[1]]);
                      } else {
                        setAuditDateRange(null);
                      }
                      setAuditPage(1);
                    }}
                  />
                </Space>
              </Card>

              <Card title={`审计日志（共 ${auditTotal} 条）`}>
                <Table<AuditLog>
                  rowKey="id"
                  dataSource={auditLogs}
                  loading={loading}
                  pagination={{
                    current: auditPage,
                    pageSize: auditPageSize,
                    total: auditTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (nextPage, nextPageSize) => {
                      setAuditPage(nextPageSize === auditPageSize ? nextPage : 1);
                      setAuditPageSize(nextPageSize);
                    }
                  }}
                  scroll={{ x: 960 }}
                  onChange={(_, _filters, sorter, extra) => {
                    if (extra.action !== 'sort') return;
                    const active = Array.isArray(sorter) ? sorter[0] : sorter;
                    if (!active?.order || active.columnKey !== 'createdAt') {
                      setAuditOrder(undefined);
                    } else {
                      setAuditOrder(active.order === 'ascend' ? 'asc' : 'desc');
                    }
                    setAuditPage(1);
                  }}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      key: 'createdAt',
                      width: 170,
                      sorter: true,
                      sortOrder: auditOrder ? (auditOrder === 'asc' ? 'ascend' : 'descend') : null,
                      render: (_, log) => new Date(log.createdAt).toLocaleString('zh-CN')
                    },
                    {
                      title: '动作',
                      dataIndex: 'action',
                      key: 'action',
                      width: 200,
                      render: (action: string) => <Typography.Text code>{action}</Typography.Text>
                    },
                    {
                      title: '管理员',
                      key: 'admin',
                      width: 120,
                      render: (_, log) => (log.adminUsername ? log.adminUsername : <span className="muted">—</span>)
                    },
                    {
                      title: '用户',
                      key: 'user',
                      width: 180,
                      render: (_, log) =>
                        log.userId ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{log.userId}</Typography.Text> : <span className="muted">—</span>
                    },
                    {
                      title: '目标',
                      key: 'target',
                      width: 180,
                      render: (_, log) =>
                        log.targetId ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{log.targetId}</Typography.Text> : <span className="muted">—</span>
                    },
                    {
                      title: '详情',
                      key: 'metadata',
                      render: (_, log) =>
                        log.metadata ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                            {JSON.stringify(log.metadata)}
                          </Typography.Text>
                        ) : (
                          <span className="muted">—</span>
                        )
                    }
                  ]}
                />
              </Card>
            </>
          ) : (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: isMobile ? '100%' : undefined }}>
                  <Select<'' | OfficialBag['status']>
                    value={statusFilter}
                    onChange={(value) => {
                      setStatusFilter(value);
                      setBagPage(1);
                    }}
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
                    onSearch={(value) => {
                      setSearch(value);
                      setBagPage(1);
                    }}
                    onChange={(event) => {
                      if (!event.target.value) {
                        setSearch('');
                        setBagPage(1);
                      }
                    }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} block={isMobile} onClick={() => openBagEditor('new')}>
                    新增袋子
                  </Button>
                  <Button icon={<UploadOutlined />} block={isMobile} onClick={() => setImportOpen(true)}>
                    导入 Excel
                  </Button>
                  <Button
                    icon={<ReloadOutlined />}
                    block={isMobile}
                    loading={reconciling}
                    onClick={() => void reconcileEmbeddings()}
                  >
                    补算袋子向量
                  </Button>
                </Space>
              </Card>

              <Card title={`袋子列表（共 ${bagTotal} 条）`}>
                <Table<OfficialBag>
                  rowKey="id"
                  dataSource={bags}
                  loading={loading}
                  pagination={{
                    current: bagPage,
                    pageSize: bagPageSize,
                    total: bagTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (nextPage, nextPageSize) => {
                      setBagPage(nextPageSize !== bagPageSize ? 1 : nextPage);
                      setBagPageSize(nextPageSize);
                    }
                  }}
                  onChange={(_pagination, _filters, sorter, extra) => {
                    if (extra.action !== 'sort') return;
                    const s = Array.isArray(sorter) ? sorter[0] : sorter;
                    if (s && s.order && s.columnKey) {
                      setBagSort(s.columnKey as BagSortField);
                      setBagOrder(s.order === 'ascend' ? 'asc' : 'desc');
                    } else {
                      setBagSort('sortOrder');
                      setBagOrder('desc');
                    }
                    setBagPage(1);
                  }}
                  scroll={{ x: 1100 }}
                  columns={[
                    {
                      title: 'A面图片',
                      key: 'image',
                      width: 84,
                      fixed: 'left',
                      render: (_, bag) =>
                        bag.thumbnailUrl ? (
                          <Image src={bag.thumbnailUrl} alt={bag.name} width={56} height={56} style={{ objectFit: 'contain' }} />
                        ) : (
                          <Tag>未上传</Tag>
                        )
                    },
                    {
                      title: 'B面图片',
                      key: 'backImage',
                      width: 84,
                      fixed: 'left',
                      render: (_, bag) => {
                        const backUrl = bag.sides?.BACK?.thumbnailUrl ?? bag.sides?.BACK?.displayImageUrl;
                        return backUrl ? (
                          <Image src={backUrl} alt={`${bag.name} · 反面`} width={56} height={56} style={{ objectFit: 'contain' }} />
                        ) : (
                          <Tag>未上传</Tag>
                        );
                      }
                    },
                    {
                      title: '名称 / 品牌',
                      key: 'name',
                      sorter: true,
                      sortOrder: bagSort === 'name' ? (bagOrder === 'asc' ? 'ascend' : 'descend') : null,
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
                                  setBagPage(1);
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
                    {
                      title: '特征向量',
                      key: 'hasEmbedding',
                      width: 110,
                      render: (_, bag) => {
                        if (bag.processStatus !== 'READY') return <span className="muted">—</span>;
                        return bag.hasEmbedding ? <Tag color="green">已有</Tag> : <Tag color="volcano">缺少</Tag>;
                      }
                    },
                    {
                      title: '拥有',
                      dataIndex: 'claimedCount',
                      key: 'claimedCount',
                      width: 72,
                      sorter: true,
                      sortOrder: bagSort === 'claimedCount' ? (bagOrder === 'asc' ? 'ascend' : 'descend') : null
                    },
                    {
                      title: '排序',
                      dataIndex: 'sortOrder',
                      key: 'sortOrder',
                      width: 72,
                      sorter: true,
                      sortOrder: bagSort === 'sortOrder' ? (bagOrder === 'asc' ? 'ascend' : 'descend') : null
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 260,
                      fixed: 'right',
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
                          <Popconfirm
                            title={`确定删除「${bag.name}」？`}
                            description={
                              bag.claimedCount > 0
                                ? `已有 ${bag.claimedCount} 位用户拥有，删除会清除他们的拥有记录与心愿标记（不影响其已收藏到自己架子的袋子）`
                                : '已删除的图片无法恢复'
                            }
                            okText="删除"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void removeBag(bag)}
                          >
                            <Button size="small" danger>删除</Button>
                          </Popconfirm>
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
              <ImportBagsModal
                open={importOpen}
                onClose={() => setImportOpen(false)}
                onDone={() => {
                  setImportOpen(false);
                  void loadBags();
                  void loadBrands();
                }}
              />
            </>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

/** 右上角的构建信息：版本号 + 构建时间，方便核对线上是否已发布到最新代码。 */
function BuildMeta() {
  const isMobile = useIsMobile();
  const shortVersion = __VERSION__.length > 8 ? __VERSION__.slice(0, 8) : __VERSION__;
  const buildTime = (() => {
    const date = new Date(__BUILD_TIME__);
    return Number.isNaN(date.getTime()) ? __BUILD_TIME__ : date.toLocaleString('zh-CN', { hour12: false });
  })();

  return (
    <Tooltip title={`版本 ${__VERSION__} · 构建于 ${buildTime}`}>
      <span className="build-meta">
        <Typography.Text code>v{shortVersion}</Typography.Text>
        {!isMobile && <Typography.Text type="secondary">{buildTime}</Typography.Text>}
      </span>
    </Tooltip>
  );
}

function OverviewPage({
  overview,
  jobs,
  loading,
  jobPage,
  jobPageSize,
  jobTotal,
  onJobPageChange
}: {
  overview: Overview | null;
  jobs: Job[];
  loading: boolean;
  jobPage: number;
  jobPageSize: number;
  jobTotal: number;
  /** 翻页 / 改每页条数：交回主组件带页码重新拉取 */
  onJobPageChange: (page: number, pageSize: number) => void;
}) {
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
      <Card title={`图片任务（共 ${jobTotal} 条）`}>
        <Table<Job>
          rowKey="id"
          dataSource={jobs}
          loading={loading}
          pagination={{
            current: jobPage,
            pageSize: jobPageSize,
            total: jobTotal,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: onJobPageChange
          }}
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
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sideFiles, setSideFiles] = useState<Record<ImageSide, UploadFile[]>>({ FRONT: [], BACK: [] });
  const [frontMatting, setFrontMatting] = useState(bag?.matting ?? false);
  const [backMatting, setBackMatting] = useState(bag?.sides?.BACK?.matting ?? false);
  const [quickBrandOpen, setQuickBrandOpen] = useState(false);
  const [quickBrandName, setQuickBrandName] = useState('');
  const [quickBrandSaving, setQuickBrandSaving] = useState(false);


  async function uploadTo(bagId: string, file: File, matting: boolean, side: ImageSide = 'FRONT') {
    const data = new FormData();
    data.append('file', file);
    // 把当前开关一起带上：勾了抠图这次上传就按抠图处理，无需先保存表单。
    return api<{ version: number; processStatus: string }>(`/official-bags/${bagId}/image?matting=${matting}&side=${side}`, {
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
        matting: frontMatting,
        backMatting,
        ...(bag ? { sortOrder: values.sortOrder } : {})
      };
      let targetId = bag?.id ?? createdId;
      if (targetId) await api(`/official-bags/${targetId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else {
        const created = await api<OfficialBag>('/official-bags', { method: 'POST', body: JSON.stringify(payload) });
        targetId = created.id; setCreatedId(targetId);
      }
      for (const side of ['FRONT', 'BACK'] as const) {
        const file = sideFiles[side][0]?.originFileObj;
        if (file) {
          await uploadTo(targetId, file, side === 'FRONT' ? frontMatting : backMatting, side);
          setSideFiles(current => ({ ...current, [side]: [] }));
        }
      }
      message.success('保存成功');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function replaceImage(side: ImageSide) {
    if (!bag) return;
    const file = sideFiles[side][0]?.originFileObj;
    if (!file) {
      message.warning('请先点击「选择图片」选一张图片');
      return;
    }
    setUploading(true);
    try {
      await uploadTo(bag.id, file, side === 'FRONT' ? frontMatting : backMatting, side);
      message.success('已上传，图片处理中');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  /** 按面删除原图与衍生图；已发布正面须先下架。 */
  async function removeImage(side: ImageSide) {
    if (!bag) return;
    setRemoving(true);
    try {
      await api(`/official-bags/${bag.id}/image?side=${side}`, { method: 'DELETE' });
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

        <Form.Item label="A/B 面图片">
          <Row gutter={[12, 12]}>
            {(['FRONT', 'BACK'] as const).map(side => {
              const image = bag?.sides?.[side];
              const url = image?.displayImageUrl ?? (side === 'FRONT' ? bag?.displayImageUrl : undefined);
              return <Col span={12} key={side}><Card size="small" title={side === 'FRONT' ? 'A 面 · 正面主图' : 'B 面 · 反面（可选）'}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {url ? <Image src={url} width={120} height={140} style={{ objectFit: 'contain' }} /> : <Typography.Text type="secondary">暂无图片</Typography.Text>}
                  {image && <Tag>{image.processingStatus === 'PROCESSING' ? '处理中' : image.processingStatus === 'READY' ? '就绪' : image.processingStatus === 'FAILED' ? '失败' : '未上传'}</Tag>}
                  {image?.processingError && <Typography.Text type="danger">{image.processingError}</Typography.Text>}
                  {side === 'FRONT'
                    ? <Space><Switch checked={frontMatting} onChange={setFrontMatting} /><Typography.Text>正面抠图</Typography.Text></Space>
                    : <Space><Switch checked={backMatting} onChange={setBackMatting} /><Typography.Text>反面抠图</Typography.Text></Space>}
                  <Upload accept="image/jpeg,image/png,image/webp,image/heic,image/heif" maxCount={1} fileList={sideFiles[side]} beforeUpload={() => false} onChange={({ fileList: files }) => setSideFiles(current => ({ ...current, [side]: files }))}>
                    <Button icon={<UploadOutlined />}>选择图片</Button>
                  </Upload>
                  {bag && <Button onClick={() => void replaceImage(side)} loading={uploading} disabled={image?.processingStatus === 'PROCESSING'}>上传 / 替换</Button>}
                  {bag && !!image?.sourceVersion && <Popconfirm title={`移除${side === 'FRONT' ? '正面' : '反面'}图片？`} description={side === 'FRONT' ? '正面主图须先下架才能移除。' : '已认领收藏刷新后也将移除反面。'} onConfirm={() => void removeImage(side)}><Button danger size="small" loading={removing} disabled={side === 'FRONT' && bag.status === 'PUBLISHED'}>移除图片</Button></Popconfirm>}
                </Space>
              </Card></Col>;
            })}
          </Row>
          <Typography.Text type="secondary">保存后将上传已选择的 A/B 面图片，并保存两面的抠图设置。</Typography.Text>
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
      {bag && <ReferenceImages bagId={bag.id} />}
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
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [displayFile, setDisplayFile] = useState<UploadFile[]>([]);

  async function uploadTo(brandId: string, file: File) {
    const data = new FormData();
    data.append('file', file);
    return api<Brand>(`/brands/${brandId}/image`, { method: 'POST', body: data });
  }

  async function save(values: BrandFormValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        ...(brand ? { sortOrder: values.sortOrder } : {})
      };
      let targetId = brand?.id;
      if (brand) {
        await api(`/brands/${brand.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const created = await api<Brand>('/brands', { method: 'POST', body: JSON.stringify(payload) });
        targetId = created.id;
      }
      const file = displayFile[0]?.originFileObj;
      if (targetId && file) {
        await uploadTo(targetId, file);
        setDisplayFile([]);
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
    if (!brand) return;
    const file = displayFile[0]?.originFileObj;
    if (!file) {
      message.warning('请先点击「选择图片」选一张图片');
      return;
    }
    setUploading(true);
    try {
      await uploadTo(brand.id, file);
      message.success('展示图已更新');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function removeImage() {
    if (!brand) return;
    setRemoving(true);
    try {
      await api(`/brands/${brand.id}/image`, { method: 'DELETE' });
      message.success('展示图已移除');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '移除失败');
    } finally {
      setRemoving(false);
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
        <Form.Item label="展示图">
          <Space direction="vertical" style={{ width: '100%' }}>
            {brand?.displayImageUrl
              ? <Image src={brand.displayImageUrl} width={120} height={120} style={{ objectFit: 'contain' }} />
              : <Typography.Text type="secondary">暂无展示图</Typography.Text>}
            <Upload
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              maxCount={1}
              fileList={displayFile}
              beforeUpload={() => false}
              onChange={({ fileList: files }) => setDisplayFile(files)}
            >
              <Button icon={<UploadOutlined />}>选择图片</Button>
            </Upload>
            {brand && (
              <Space>
                <Button onClick={() => void replaceImage()} loading={uploading}>上传 / 替换</Button>
                {brand.displayImageUrl && (
                  <Popconfirm title="移除展示图？" onConfirm={() => void removeImage()}>
                    <Button danger size="small" loading={removing}>移除图片</Button>
                  </Popconfirm>
                )}
              </Space>
            )}
          </Space>
          <Typography.Text type="secondary">保存后将上传已选择的展示图。</Typography.Text>
        </Form.Item>
        {brand && (
          <Form.Item name="sortOrder" label="排序（数字越大越靠前）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving || uploading}>保存</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface PromoteFormValues {
  name: string;
  brandId?: string | null;
  notes?: string;
  tags?: string;
}

function PromoteSubmissionModal({
  submission,
  brands,
  onClose,
  onDone
}: {
  submission: Submission | null;
  brands: Brand[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [saving, setSaving] = useState(false);

  async function save(values: PromoteFormValues) {
    if (!submission) return;
    setSaving(true);
    try {
      const payload = {
        name: values.name.trim(),
        brandId: values.brandId ?? null,
        notes: values.notes ?? '',
        tags: values.tags ? values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : []
      };
      const result = await api<{ officialBagName: string }>(`/submissions/${submission.id}/promote`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      message.success(`已纳入官方袋子库「${result.officialBagName}」，可在官方袋子库中发布`);
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '纳入失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={submission ? `纳入官方：${submission.name}` : '纳入官方'}
      open={submission !== null}
      onCancel={onClose}
      width={isMobile ? '100%' : 560}
      footer={null}
      destroyOnHidden
    >
      <Form<PromoteFormValues>
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{
          name: submission?.name ?? '',
          brandId: null,
          notes: submission?.notes ?? '',
          tags: submission?.tags.join('，') ?? ''
        }}
      >
        <Typography.Paragraph type="secondary">
          将沿用用户上传的名称、备注与标签；图片会原样复制到官方库并直接就绪，无需重新处理。
        </Typography.Paragraph>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '名称不能为空' }, { max: 80, message: '最多 80 字' }]}
        >
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item label="品牌">
          <Form.Item name="brandId" noStyle>
            <Select
              placeholder="选择品牌（可选）"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
            />
          </Form.Item>
        </Form.Item>
        <Form.Item name="tags" label="标签（用逗号分隔）">
          <Input placeholder="手提包、老花、棕色" />
        </Form.Item>
        <Form.Item name="notes" label="备注" rules={[{ max: 2000 }]}>
          <Input.TextArea rows={3} maxLength={2000} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>纳入官方</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface RejectFormValues {
  note?: string;
}

function RejectSubmissionModal({
  submission,
  onClose,
  onDone
}: {
  submission: Submission | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [saving, setSaving] = useState(false);

  async function save(values: RejectFormValues) {
    if (!submission) return;
    setSaving(true);
    try {
      await api(`/submissions/${submission.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ note: values.note ?? '' })
      });
      message.success('已驳回');
      onDone();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '驳回失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={submission ? `驳回：${submission.name}` : '驳回'}
      open={submission !== null}
      onCancel={onClose}
      width={isMobile ? '100%' : 520}
      footer={null}
      destroyOnHidden
    >
      <Form<RejectFormValues>
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{ note: '' }}
      >
        <Form.Item name="note" label="审核意见（可选）" rules={[{ max: 500 }]}>
          <Input.TextArea rows={3} placeholder="说明驳回原因" maxLength={500} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button danger htmlType="submit" loading={saving}>驳回</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}

function UserDetailDrawer({
  user,
  loading,
  onClose,
  onEditQuota,
  onToggleStatus
}: {
  user: AdminUserDetail | null;
  loading: boolean;
  onClose: () => void;
  onEditQuota: () => void;
  onToggleStatus: (status: AdminUser['status']) => void;
}) {
  const isMobile = useIsMobile();
  return (
    <Drawer
      title={user ? `用户详情：${user.openidMasked}` : '用户详情'}
      open={user !== null}
      onClose={onClose}
      width={isMobile ? '100%' : 680}
    >
      <Spin spinning={loading}>
        {user && (
          <>
            <Descriptions column={isMobile ? 1 : 2} size="small" bordered>
              <Descriptions.Item label="用户 ID" span={isMobile ? 1 : 2}>{user.id}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={userStatusColors[user.status]}>{userStatusLabels[user.status]}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="有 unionid">{user.hasUnionid ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="openid" span={isMobile ? 1 : 2}>{user.openidMasked}</Descriptions.Item>
              {user.unionid && (
                <Descriptions.Item label="unionid" span={isMobile ? 1 : 2}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>{user.unionid}</Typography.Text>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="收藏数">{user.collectibleCount}</Descriptions.Item>
              <Descriptions.Item label="架子数">{user.shelfCount}</Descriptions.Item>
              <Descriptions.Item label="存储用量">
                {formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageQuotaBytes)}
              </Descriptions.Item>
              <Descriptions.Item label="收藏配额">{user.collectibleQuota}</Descriptions.Item>
              <Descriptions.Item label="每日抠图配额">{user.dailyMattingQuota}</Descriptions.Item>
              <Descriptions.Item label="注册时间">{new Date(user.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="最近登录">{new Date(user.lastLoginAt).toLocaleString('zh-CN')}</Descriptions.Item>
            </Descriptions>

            <Space style={{ marginTop: 16 }} wrap>
              <Button type="primary" onClick={onEditQuota}>调整配额</Button>
              {user.status === 'ACTIVE' ? (
                <Popconfirm
                  title="确定封禁该用户？"
                  description="封禁后将撤销其全部登录会话"
                  okText="封禁"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onToggleStatus('SUSPENDED')}
                >
                  <Button danger>封禁</Button>
                </Popconfirm>
              ) : (
                <Button onClick={() => onToggleStatus('ACTIVE')}>解封</Button>
              )}
            </Space>

            <Typography.Title level={5} style={{ marginTop: 24 }}>
              最近收藏（{user.recentCollectibles.length}）
            </Typography.Title>
            <Table
              rowKey="id"
              dataSource={user.recentCollectibles}
              pagination={false}
              size="small"
              scroll={{ x: 520 }}
              columns={[
                { title: '名称', dataIndex: 'name', key: 'name' },
                { title: '架子', dataIndex: 'shelfName', key: 'shelfName', width: 120 },
                {
                  title: '图片状态',
                  dataIndex: 'processingStatus',
                  key: 'processingStatus',
                  width: 120,
                  render: (status: string) => (status === 'READY' ? <Tag color="green">就绪</Tag> : <Tag>{status}</Tag>)
                },
                {
                  title: '加入时间',
                  dataIndex: 'addedAt',
                  key: 'addedAt',
                  width: 170,
                  render: (value: string) => new Date(value).toLocaleString('zh-CN')
                }
              ]}
            />
          </>
        )}
      </Spin>
    </Drawer>
  );
}

interface QuotaFormValues {
  storageQuotaBytes: number;
  collectibleQuota: number;
  dailyMattingQuota: number;
}

function UserQuotaModal({
  user,
  onClose,
  onDone
}: {
  user: AdminUserDetail | null;
  onClose: () => void;
  onDone: (updated: AdminUserDetail) => void;
}) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [saving, setSaving] = useState(false);

  async function save(values: QuotaFormValues) {
    if (!user) return;
    setSaving(true);
    try {
      const payload: Record<string, number> = {};
      if (values.storageQuotaBytes !== user.storageQuotaBytes) payload.storageQuotaBytes = values.storageQuotaBytes;
      if (values.collectibleQuota !== user.collectibleQuota) payload.collectibleQuota = values.collectibleQuota;
      if (values.dailyMattingQuota !== user.dailyMattingQuota) payload.dailyMattingQuota = values.dailyMattingQuota;
      if (Object.keys(payload).length === 0) {
        message.info('没有修改任何配额');
        return;
      }
      const updated = await api<AdminUserDetail>(`/users/${user.id}/quota`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      message.success('配额已更新');
      onDone(updated);
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={user ? `调整配额：${user.openidMasked}` : '调整配额'}
      open={user !== null}
      onCancel={onClose}
      width={isMobile ? '100%' : 520}
      footer={null}
      destroyOnHidden
    >
      <Form<QuotaFormValues>
        key={user?.id ?? 'empty'}
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{
          storageQuotaBytes: user?.storageQuotaBytes ?? 0,
          collectibleQuota: user?.collectibleQuota ?? 0,
          dailyMattingQuota: user?.dailyMattingQuota ?? 0
        }}
      >
        <Typography.Paragraph type="secondary">只提交有改动的字段；当前用量与默认值供参考。</Typography.Paragraph>
        <Form.Item name="storageQuotaBytes" label="存储配额（字节）" rules={[{ required: true, message: '请输入存储配额' }]}>
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="collectibleQuota" label="收藏数量配额" rules={[{ required: true, message: '请输入收藏配额' }]}>
          <InputNumber min={0} max={1000000} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="dailyMattingQuota" label="每日抠图配额" rules={[{ required: true, message: '请输入抠图配额' }]}>
          <InputNumber min={0} max={10000} style={{ width: '100%' }} />
        </Form.Item>
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

/** 可导入字段的列名关键词，用于自动识别表头。 */
const IMPORT_FIELDS: { key: ImportField; label: string; keywords: string[] }[] = [
  { key: 'name', label: '名称', keywords: ['名称', '名字', 'name'] },
  { key: 'brandName', label: '品牌', keywords: ['品牌', 'brand'] },
  { key: 'tags', label: '标签', keywords: ['标签', 'tag'] },
  { key: 'notes', label: '描述 / 记录', keywords: ['记录', '描述', '备注', '说明', '简介', 'note', 'desc', 'detail'] }
];

const EMPTY_MAPPING: Record<ImportField, number | null> = { name: null, brandName: null, tags: null, notes: null };

function ImportBagsModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<ImportField, number | null>>(EMPTY_MAPPING);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);

  function matchColumn(header: string): ImportField | null {
    const h = header.trim().toLocaleLowerCase();
    if (!h) return null;
    for (const field of IMPORT_FIELDS) {
      if (field.keywords.some((kw) => h.includes(kw.toLocaleLowerCase()))) return field.key;
    }
    return null;
  }

  /** 在前几行里找「最像表头」的那一行：包含列关键词最多的行。 */
  function findHeaderRow(grid: unknown[][]): number {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < Math.min(grid.length, 6); i++) {
      const score = (grid[i] ?? []).reduce<number>(
        (acc, cell) => acc + (matchColumn(cell == null ? '' : String(cell)) ? 1 : 0),
        0
      );
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return bestScore > 0 ? best : 0;
  }

  async function parseFile(file: File) {
    setParsing(true);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('Excel 文件为空');
      const ws = wb.Sheets[sheetName];
      if (!ws) throw new Error('Excel 文件为空');
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
      if (!grid.length) throw new Error('Excel 没有内容');

      const headerRow = grid[findHeaderRow(grid)] ?? [];
      const newHeaders = headerRow.map((cell, idx) => {
        const text = cell == null ? '' : String(cell).trim();
        return text === '' ? `列${idx + 1}` : text;
      });
      const newRows = grid
        .slice(findHeaderRow(grid) + 1)
        .map((row) => newHeaders.map((_, idx) => (row[idx] == null ? '' : String(row[idx]).trim())))
        .filter((row) => row.some((cell) => cell !== ''));

      const nextMapping: Record<ImportField, number | null> = { ...EMPTY_MAPPING };
      newHeaders.forEach((header, idx) => {
        const field = matchColumn(header);
        if (field && nextMapping[field] === null) nextMapping[field] = idx;
      });

      setHeaders(newHeaders);
      setRows(newRows);
      setMapping(nextMapping);
      if (!newRows.length) message.warning('未解析到数据行，请确认表头在文件前几行');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '解析失败');
      setHeaders([]);
      setRows([]);
      setMapping({ ...EMPTY_MAPPING });
    } finally {
      setParsing(false);
    }
  }

  async function doImport() {
    if (mapping.name === null) {
      message.warning('请先指定「名称」对应的列');
      return;
    }
    const items: ImportBagRow[] = [];
    for (const row of rows) {
      const name = row[mapping.name] ?? '';
      if (!name) continue;
      const item: ImportBagRow = { name };
      const brandName = mapping.brandName !== null ? (row[mapping.brandName] ?? '') : '';
      const notes = mapping.notes !== null ? (row[mapping.notes] ?? '') : '';
      const tagsText = mapping.tags !== null ? (row[mapping.tags] ?? '') : '';
      if (brandName) item.brandName = brandName;
      if (notes) item.notes = notes;
      if (tagsText) item.tags = tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      items.push(item);
    }
    if (!items.length) {
      message.warning('没有有效数据（名称列为空）');
      return;
    }
    setImporting(true);
    try {
      const result = await api<{ created: number }>('/official-bags/import', {
        method: 'POST',
        body: JSON.stringify({ items })
      });
      message.success(`已导入 ${result.created} 条，均为草稿，补图后手动发布`);
      onDone();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }

  const mappingOptions = headers.map((header, idx) => ({ value: idx, label: header }));
  const preview = rows.slice(0, 10);

  return (
    <Modal
      title="导入 Excel 袋子"
      open={open}
      onCancel={onClose}
      width={isMobile ? '100%' : 820}
      footer={null}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Upload
          accept=".xlsx,.xls"
          maxCount={1}
          fileList={fileList}
          beforeUpload={(file) => {
            void parseFile(file);
            return false;
          }}
          onChange={({ fileList: next }) => {
            setFileList(next);
            if (next.length === 0) {
              setHeaders([]);
              setRows([]);
              setMapping({ ...EMPTY_MAPPING });
            }
          }}
        >
          <Button icon={<UploadOutlined />} loading={parsing}>
            选择 Excel 文件（.xlsx / .xls）
          </Button>
        </Upload>

        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          支持列：名称、品牌、标签（逗号分隔）、描述/记录。上传后自动识别表头并映射，导入的袋子全部为
          <Typography.Text strong> 草稿 </Typography.Text>
          ，需补图后手动点发布。
        </Typography.Paragraph>

        {headers.length > 0 && (
          <>
            <Card size="small" title="字段映射">
              <Row gutter={16}>
                {IMPORT_FIELDS.map((field) => (
                  <Col xs={12} md={6} key={field.key}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {field.label}
                    </Typography.Text>
                    <Select<number | null>
                      value={mapping[field.key]}
                      onChange={(value) => setMapping((prev) => ({ ...prev, [field.key]: value ?? null }))}
                      allowClear
                      placeholder="不导入"
                      style={{ width: '100%', marginTop: 4 }}
                      options={mappingOptions}
                    />
                  </Col>
                ))}
              </Row>
            </Card>

            <Card size="small" title={`数据预览（共 ${rows.length} 行，显示前 ${preview.length} 行）`}>
              <Table<string[]>
                rowKey={(_, index) => String(index)}
                dataSource={preview}
                size="small"
                pagination={false}
                scroll={{ x: 640 }}
                columns={IMPORT_FIELDS.map((field) => ({
                  title: field.label,
                  key: field.key,
                  ellipsis: true,
                  render: (_, row) => {
                    const value = mapping[field.key] === null ? '' : row[mapping[field.key]!];
                    return value || <span className="muted">—</span>;
                  }
                }))}
              />
            </Card>
          </>
        )}

        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            onClick={() => void doImport()}
            loading={importing}
            disabled={!rows.length || mapping.name === null}
          >
            导入
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
