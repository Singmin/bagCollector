import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, ComponentProps, ReactNode } from 'react';
import {
  App as AntdApp,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload
} from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  HistoryOutlined,
  PictureOutlined,
  PlusOutlined,
  SendOutlined,
  UnorderedListOutlined
} from '@ant-design/icons';
import { api } from './api';

type ReleaseStatus = 'PLANNED' | 'DONE';

const releaseStatusLabels: Record<ReleaseStatus, string> = {
  PLANNED: '计划中',
  DONE: '已完成'
};

const releaseStatusColors: Record<ReleaseStatus, string> = {
  PLANNED: 'gold',
  DONE: 'green'
};

interface ReleaseComment {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

interface ReleaseNote {
  id: string;
  version: string;
  title: string;
  content: string;
  status: ReleaseStatus;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ReleasePage {
  items: ReleaseNote[];
  totalCount: number;
}

interface PlanItem {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ReleaseFormValues {
  version: string;
  title: string;
  content?: string;
  status?: ReleaseStatus;
}

/** 仓库 docs/ 下的改动记录 md，后端按日期倒序返回，与文件同步、无需手工录入。 */
interface ChangelogDoc {
  id: string;
  date: string | null;
  title: string;
  content: string;
}

/** 一次最多拉取的版本记录条数：运营场景下远够用，暂不做翻页。 */
const RELEASE_PAGE_SIZE = 200;

/** 正文里的 markdown 图片标记，如 ![图](https://...)，粘贴图片上传成功后写入正文。 */
const RELEASE_IMAGE_TOKEN_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/;

/** 列表预览用：去掉图片标记，只留纯文本。 */
function stripImageTokens(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 版本记录正文渲染：文本按行展示，图片标记渲染成可点击预览的图。 */
function ReleaseContent({ content }: { content: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {content.split('\n').map((line, lineIndex) => {
        const pieces: ReactNode[] = [];
        const regex = new RegExp(RELEASE_IMAGE_TOKEN_RE.source, 'g');
        let cursor = 0;
        let key = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          if (match.index > cursor) pieces.push(<span key={key++}>{line.slice(cursor, match.index)}</span>);
          pieces.push(
            <Image key={key++} src={match[2] ?? ''} alt={match[1] || '改动截图'} width={240} style={{ borderRadius: 8 }} />
          );
          cursor = match.index + match[0].length;
        }
        if (cursor < line.length) pieces.push(<span key={key++}>{line.slice(cursor)}</span>);
        return <div key={lineIndex}>{pieces}</div>;
      })}
    </div>
  );
}

let pasteUploadSeq = 0;

/**
 * 改动内容输入框：支持直接粘贴图片或点「插入图片」选图。
 * 上传期间先在光标处占位「![图片上传中…](uploading-n)」，成功后原地替换成正式图片标记，
 * 失败则移除占位，不打断文字编辑。
 */
function ContentInput({
  value,
  onChange,
  onUploadImage,
  uploading,
  ...rest
}: {
  value?: string;
  onChange?: (value: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  uploading: boolean;
} & Omit<ComponentProps<typeof Input.TextArea>, 'value' | 'onChange'>) {
  const { message } = AntdApp.useApp();
  const latest = useRef(value ?? '');
  useEffect(() => {
    latest.current = value ?? '';
  }, [value]);

  const applyChange = useCallback(
    (next: string) => {
      latest.current = next;
      onChange?.(next);
    },
    [onChange]
  );

  const insertFiles = useCallback(
    async (files: File[], position: number) => {
      let at = Math.min(Math.max(position, 0), latest.current.length);
      for (const file of files) {
        const placeholder = `![图片上传中…](uploading-${++pasteUploadSeq})`;
        applyChange(latest.current.slice(0, at) + placeholder + latest.current.slice(at));
        at += placeholder.length;
        try {
          const url = await onUploadImage(file);
          const token = `![图](${url})`;
          const text = latest.current;
          const index = text.indexOf(placeholder);
          if (index >= 0) applyChange(text.slice(0, index) + token + text.slice(index + placeholder.length));
          at += token.length - placeholder.length;
        } catch (error) {
          const text = latest.current;
          const index = text.indexOf(placeholder);
          if (index >= 0) applyChange(text.slice(0, index) + text.slice(index + placeholder.length));
          at -= placeholder.length;
          message.error(error instanceof Error ? error.message : '图片上传失败');
        }
      }
    },
    [applyChange, onUploadImage, message]
  );

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    // currentTarget 在 await 之后会失效，先取好光标位置和 DOM 引用
    const start = event.currentTarget.selectionStart ?? latest.current.length;
    const end = event.currentTarget.selectionEnd ?? start;
    applyChange(latest.current.slice(0, start) + latest.current.slice(end));
    await insertFiles(files, start);
  }

  return (
    <div>
      <Space style={{ marginBottom: 8 }} size={8}>
        <Upload
          accept="image/*"
          showUploadList={false}
          multiple
          beforeUpload={(file) => {
            void insertFiles([file], latest.current.length);
            return false;
          }}
        >
          <Button size="small" icon={<PictureOutlined />} loading={uploading}>
            插入图片
          </Button>
        </Upload>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          也可直接在输入框里粘贴截图
        </Typography.Text>
      </Space>
      <Input.TextArea
        {...rest}
        value={value}
        onChange={(event) => applyChange(event.target.value)}
        onPaste={(event) => void handlePaste(event)}
      />
    </div>
  );
}

/**
 * 「版本改动」页面：版本记录（含留言）+ 下期计划。
 *
 * 版本记录按时间倒序展示，点开一条可看正文、留言、编辑或删除；
 * 下期计划是一个简单待办清单，做完打勾。
 */
export function ChangelogPage() {
  const { message } = AntdApp.useApp();
  const [activeTab, setActiveTab] = useState('docs');
  const [docs, setDocs] = useState<ChangelogDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docDetail, setDocDetail] = useState<ChangelogDoc | null>(null);
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [releaseStatusFilter, setReleaseStatusFilter] = useState<'' | ReleaseStatus>('');
  const [editing, setEditing] = useState<ReleaseNote | 'new' | null>(null);
  const [detail, setDetail] = useState<ReleaseNote | null>(null);
  const [comments, setComments] = useState<ReleaseComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [planDraft, setPlanDraft] = useState('');
  const [addingPlan, setAddingPlan] = useState(false);

  /** 拉取版本记录；返回最新列表，供保存后同步详情抽屉里的数据。 */
  const loadNotes = useCallback(async (): Promise<ReleaseNote[]> => {
    setNotesLoading(true);
    try {
      const params = new URLSearchParams();
      if (releaseStatusFilter) params.set('status', releaseStatusFilter);
      params.set('page', '1');
      params.set('pageSize', String(RELEASE_PAGE_SIZE));
      const result = await api<ReleasePage>(`/releases?${params.toString()}`);
      setNotes(result.items);
      return result.items;
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '加载版本记录失败');
      return [];
    } finally {
      setNotesLoading(false);
    }
  }, [message, releaseStatusFilter]);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      setDocs(await api<ChangelogDoc[]>('/changelog-docs'));
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '加载改动文档失败');
    } finally {
      setDocsLoading(false);
    }
  }, [message]);

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    try {
      setPlans(await api<PlanItem[]>('/plans'));
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '加载下期计划失败');
    } finally {
      setPlansLoading(false);
    }
  }, [message]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (activeTab === 'docs') void loadDocs();
      else if (activeTab === 'releases') void loadNotes();
      else void loadPlans();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, loadDocs, loadNotes, loadPlans]);

  const openDetail = useCallback(
    async (note: ReleaseNote) => {
      setDetail(note);
      setComments([]);
      setCommentDraft('');
      setCommentsLoading(true);
      try {
        setComments(await api<ReleaseComment[]>(`/releases/${note.id}/comments`));
      } catch (requestError) {
        message.error(requestError instanceof Error ? requestError.message : '加载留言失败');
      } finally {
        setCommentsLoading(false);
      }
    },
    [message]
  );

  async function sendComment() {
    if (!detail) return;
    const content = commentDraft.trim();
    if (!content) {
      message.warning('留言内容不能为空');
      return;
    }
    setSendingComment(true);
    try {
      const created = await api<ReleaseComment>(`/releases/${detail.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content })
      });
      setComments((prev) => [...prev, created]);
      setCommentDraft('');
      // 留言数变化，刷新列表里的计数。
      void loadNotes();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '留言失败');
    } finally {
      setSendingComment(false);
    }
  }

  async function removeComment(commentId: string) {
    if (!detail) return;
    try {
      await api(`/releases/${detail.id}/comments/${commentId}`, { method: 'DELETE' });
      setComments((prev) => prev.filter((comment) => comment.id !== commentId));
      void loadNotes();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除留言失败');
    }
  }

  async function removeNote(note: ReleaseNote) {
    try {
      await api(`/releases/${note.id}`, { method: 'DELETE' });
      message.success('已删除该版本记录');
      if (detail?.id === note.id) setDetail(null);
      void loadNotes();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除失败');
    }
  }

  /** 快捷切换状态：计划中 ↔ 已完成。改完按当前筛选重新拉取，保持列表一致。 */
  async function toggleReleaseStatus(note: ReleaseNote) {
    const next: ReleaseStatus = note.status === 'DONE' ? 'PLANNED' : 'DONE';
    try {
      const updated = await api<ReleaseNote>(`/releases/${note.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next })
      });
      if (detail?.id === note.id) setDetail(updated);
      message.success(next === 'DONE' ? '已标记为已完成' : '已改回计划中');
      await loadNotes();
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '更新失败');
    }
  }

  async function addPlan() {
    const title = planDraft.trim();
    if (!title) {
      message.warning('请输入下期要做的改动');
      return;
    }
    setAddingPlan(true);
    try {
      const created = await api<PlanItem>('/plans', { method: 'POST', body: JSON.stringify({ title }) });
      setPlans((prev) => [...prev, created]);
      setPlanDraft('');
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '添加失败');
    } finally {
      setAddingPlan(false);
    }
  }

  async function togglePlan(item: PlanItem, done: boolean) {
    try {
      const updated = await api<PlanItem>(`/plans/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done })
      });
      setPlans((prev) => prev.map((p) => (p.id === item.id ? updated : p)));
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '更新失败');
    }
  }

  async function removePlan(item: PlanItem) {
    try {
      await api(`/plans/${item.id}`, { method: 'DELETE' });
      setPlans((prev) => prev.filter((p) => p.id !== item.id));
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '删除失败');
    }
  }

  const docsTab = (
    <Spin spinning={docsLoading}>
      {docs.length === 0 && !docsLoading ? (
        <Empty description="docs/ 下还没有改动记录文档（CHANGES-*.md / UI-CHANGES-*.md）" />
      ) : (
        <>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            共 {docs.length} 篇，来自仓库 docs/ 下的改动记录 md，按文件名日期倒序，随每次部署自动更新。
          </Typography.Text>
          <List
            itemLayout="horizontal"
            dataSource={docs}
            renderItem={(doc) => (
              <List.Item style={{ cursor: 'pointer' }} onClick={() => setDocDetail(doc)}>
                <List.Item.Meta
                  title={
                    <Space size={8} wrap>
                      {doc.date && <Tag color="blue">{doc.date}</Tag>}
                      <Typography.Text strong>{doc.title}</Typography.Text>
                    </Space>
                  }
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {doc.id}
                    </Typography.Text>
                  }
                />
                <Typography.Paragraph
                  style={{ margin: 0, maxWidth: 480 }}
                  ellipsis={{ rows: 2, expandable: false }}
                  type="secondary"
                >
                  {doc.content.replace(/^#\s+.*$/m, '').trim() || '（无正文）'}
                </Typography.Paragraph>
              </List.Item>
            )}
          />
        </>
      )}
    </Spin>
  );

  const releasesTab = (
    <Spin spinning={notesLoading}>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select<'' | ReleaseStatus>
          value={releaseStatusFilter}
          onChange={setReleaseStatusFilter}
          style={{ width: 140 }}
          options={[
            { value: '', label: '全部状态' },
            { value: 'PLANNED', label: '计划中' },
            { value: 'DONE', label: '已完成' }
          ]}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          新增版本记录
        </Button>
        <Typography.Text type="secondary">共 {notes.length} 条版本记录</Typography.Text>
      </Space>

      {notes.length === 0 && !notesLoading ? (
        <Empty description="还没有版本记录，点上方按钮新增一条" />
      ) : (
        <Table<ReleaseNote>
          rowKey="id"
          dataSource={notes}
          size="middle"
          onRow={(note) => ({ onClick: () => void openDetail(note), style: { cursor: 'pointer' } })}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
          columns={[
            {
              title: '版本',
              dataIndex: 'version',
              width: 110,
              render: (version: string) => <Tag color="blue">{version}</Tag>
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (status: ReleaseStatus) => (
                <Tag color={releaseStatusColors[status]}>{releaseStatusLabels[status]}</Tag>
              )
            },
            {
              title: '标题',
              dataIndex: 'title',
              ellipsis: true,
              render: (title: string) => <Typography.Text strong>{title}</Typography.Text>
            },
            {
              title: '改动内容',
              dataIndex: 'content',
              ellipsis: true,
              render: (content: string) => (
                <Typography.Text type="secondary">{stripImageTokens(content) || '（无正文）'}</Typography.Text>
              )
            },
            {
              title: '留言',
              dataIndex: 'commentCount',
              width: 64,
              align: 'center',
              render: (count: number) =>
                count > 0 ? <Typography.Text>{count}</Typography.Text> : (
                  <Typography.Text type="secondary">-</Typography.Text>
                )
            },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (createdAt: string) => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(createdAt).toLocaleString('zh-CN')}
                </Typography.Text>
              )
            },
            {
              title: '操作',
              key: 'actions',
              width: 250,
              render: (_, note) => (
                // 阻止冒泡到 onRow 的整行点击（打开详情）
                <Space size={0} onClick={(event) => event.stopPropagation()}>
                  <Button
                    type="link"
                    size="small"
                    icon={<CheckOutlined />}
                    onClick={() => void toggleReleaseStatus(note)}
                  >
                    {note.status === 'DONE' ? '改回计划' : '标记完成'}
                  </Button>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(note)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除这条版本记录？"
                    description="其下留言会一并删除"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void removeNote(note)}
                  >
                    <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
      )}
    </Spin>
  );

  const plansTab = (
    <Spin spinning={plansLoading}>
      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input
          placeholder="下期要做什么改动，例如：支持拖拽排序"
          value={planDraft}
          maxLength={200}
          onChange={(event) => setPlanDraft(event.target.value)}
          onPressEnter={() => void addPlan()}
        />
        <Button type="primary" icon={<PlusOutlined />} loading={addingPlan} onClick={() => void addPlan()}>
          添加
        </Button>
      </Space.Compact>

      {plans.length === 0 && !plansLoading ? (
        <Empty description="下期计划还是空的，先把想做的改动记下来" />
      ) : (
        <List
          itemLayout="horizontal"
          dataSource={plans}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Popconfirm
                  key="delete"
                  title="删除这条计划？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removePlan(item)}
                >
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              ]}
            >
              <List.Item.Meta
                title={
                  <Checkbox checked={item.done} onChange={(event) => void togglePlan(item, event.target.checked)}>
                    <Typography.Text delete={item.done} {...(item.done ? { style: { color: '#999' } } : {})}>
                      {item.title}
                    </Typography.Text>
                  </Checkbox>
                }
                description={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Spin>
  );

  return (
    <>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'docs', label: '改动文档', icon: <FileTextOutlined />, children: docsTab },
          { key: 'releases', label: '版本记录', icon: <HistoryOutlined />, children: releasesTab },
          { key: 'plans', label: '下期计划', icon: <UnorderedListOutlined />, children: plansTab }
        ]}
      />

      <Drawer
        title={docDetail ? `${docDetail.date ?? ''} ${docDetail.title}` : '改动文档'}
        open={docDetail !== null}
        onClose={() => setDocDetail(null)}
        width={720}
      >
        {docDetail && (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {docDetail.id}
            </Typography.Text>
            <Typography.Paragraph style={{ marginTop: 16, whiteSpace: 'pre-wrap', fontSize: 13 }}>
              {docDetail.content}
            </Typography.Paragraph>
          </>
        )}
      </Drawer>

      <ReleaseEditor
        note={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onDone={async () => {
          setEditing(null);
          const items = await loadNotes();
          // 详情抽屉还开着时，用保存后的最新数据刷新它，避免显示旧内容。
          if (detail) {
            const latest = items.find((item) => item.id === detail.id);
            if (latest) setDetail(latest);
          }
        }}
      />

      <Drawer
        title={detail ? `${detail.version} · ${detail.title}` : '版本详情'}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={620}
        extra={
          detail && (
            <Space>
              <Button icon={<EditOutlined />} onClick={() => setEditing(detail)}>
                编辑
              </Button>
              <Popconfirm
                title="删除这条版本记录？"
                description="其下留言会一并删除"
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={() => void removeNote(detail)}
              >
                <Button danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {detail && (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(detail.createdAt).toLocaleString('zh-CN')}
            </Typography.Text>
            <div style={{ marginTop: 16 }}>
              {detail.content ? <ReleaseContent content={detail.content} /> : '（无正文）'}
            </div>

            <Typography.Title level={5} style={{ marginTop: 24 }}>
              留言（{comments.length}）
            </Typography.Title>
            <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
              <Input.TextArea
                placeholder="写下你的留言"
                value={commentDraft}
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={2000}
                onChange={(event) => setCommentDraft(event.target.value)}
                onPressEnter={(event) => {
                  if (!event.shiftKey) {
                    event.preventDefault();
                    void sendComment();
                  }
                }}
              />
              <Button type="primary" icon={<SendOutlined />} loading={sendingComment} onClick={() => void sendComment()}>
                发送
              </Button>
            </Space.Compact>

            <Spin spinning={commentsLoading}>
              {comments.length === 0 && !commentsLoading ? (
                <Empty description="还没有留言" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <List
                  dataSource={comments}
                  renderItem={(comment) => (
                    <List.Item
                      actions={[
                        <Popconfirm
                          key="delete"
                          title="删除这条留言？"
                          okText="删除"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void removeComment(comment.id)}
                        >
                          <Button type="link" size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      ]}
                    >
                      <List.Item.Meta
                        title={<Typography.Text strong>{comment.authorName}</Typography.Text>}
                        description={
                          <>
                            <Typography.Paragraph style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                              {comment.content}
                            </Typography.Paragraph>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {new Date(comment.createdAt).toLocaleString('zh-CN')}
                            </Typography.Text>
                          </>
                        }
                      />
                    </List.Item>
                  )}
                />
              )}
            </Spin>
          </>
        )}
      </Drawer>
    </>
  );
}

function ReleaseEditor({
  note,
  open,
  onClose,
  onDone
}: {
  note: ReleaseNote | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ReleaseFormValues>();
  const [saving, setSaving] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);

  /** 图片经 API 服务端直写 COS/本地，返回可访问 URL。 */
  async function uploadImage(file: File): Promise<string> {
    setUploadingCount((count) => count + 1);
    try {
      const data = new FormData();
      data.append('file', file);
      const result = await api<{ url: string }>('/release-images', { method: 'POST', body: data });
      return result.url;
    } finally {
      setUploadingCount((count) => count - 1);
    }
  }

  // 每次打开都按目标记录重写表单：form store 会保留上一次填的值，
  // 而 initialValues 只在首次挂载时生效 —— 不重置的话「新增」弹窗里会出现上一条的草稿。
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      version: note?.version ?? '',
      title: note?.title ?? '',
      content: note?.content ?? '',
      status: note?.status ?? 'PLANNED'
    });
  }, [open, note, form]);

  async function save(values: ReleaseFormValues) {
    setSaving(true);
    try {
      const payload = {
        version: values.version.trim(),
        title: values.title.trim(),
        content: values.content ?? '',
        status: values.status ?? 'PLANNED'
      };
      if (note) {
        await api(`/releases/${note.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/releases', { method: 'POST', body: JSON.stringify(payload) });
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
      title={note ? `编辑：${note.title}` : '新增版本记录'}
      open={open}
      onCancel={onClose}
      width={600}
      footer={null}
      destroyOnHidden
    >
      <Form<ReleaseFormValues>
        form={form}
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{
          version: note?.version ?? '',
          title: note?.title ?? '',
          content: note?.content ?? '',
          status: note?.status ?? 'PLANNED'
        }}
      >
        <Form.Item
          name="version"
          label="版本号"
          rules={[{ required: true, message: '请输入版本号' }, { max: 40, message: '最多 40 字' }]}
        >
          <Input placeholder="例如：v1.3.0 或 10.11" maxLength={40} />
        </Form.Item>
        <Form.Item name="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
          <Select
            options={[
              { value: 'PLANNED', label: '计划中（下期改动）' },
              { value: 'DONE', label: '已完成' }
            ]}
          />
        </Form.Item>
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, message: '请输入标题' }, { max: 120, message: '最多 120 字' }]}
        >
          <Input placeholder="一句话概括本次改动" maxLength={120} />
        </Form.Item>
        <Form.Item
          name="content"
          label="改动内容"
          rules={[{ max: 10000, message: '最多 10000 字' }]}
          extra="图片会以附件形式存入 COS，正文里记录其链接，详情里可预览"
        >
          <ContentInput
            rows={6}
            maxLength={10000}
            placeholder="逐条写下本次改了什么，可换行"
            uploading={uploadingCount > 0}
            onUploadImage={uploadImage}
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving} disabled={uploadingCount > 0}>
              保存
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}
