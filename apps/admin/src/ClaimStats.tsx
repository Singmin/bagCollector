import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import { CrownOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons';
import { api } from './api';

interface ClaimRow {
  id: string;
  userId: string;
  openidMasked: string;
  bagId: string;
  bagName: string;
  brandName?: string;
  collectibleId: string;
  claimedAt: string;
}

interface ClaimPage {
  items: ClaimRow[];
  totalCount: number;
}

interface ClaimedBagRank {
  bagId: string;
  bagName: string;
  brandName?: string;
  claimCount: number;
  latestClaimedAt: string;
}

/**
 * 「认领收藏」页签：用户在发现页点「标记已有」把官方袋子收进收藏的记录。
 * 上半部分是被认领最多的袋子排行（看哪些袋子最受欢迎），下半部分是认领明细。
 */
export function ClaimStats() {
  const { message } = AntdApp.useApp();
  const [topBags, setTopBags] = useState<ClaimedBagRank[]>([]);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rank, claimPage] = await Promise.all([
        api<ClaimedBagRank[]>('/submissions/claims/top'),
        (() => {
          const params = new URLSearchParams();
          if (search.trim()) params.set('search', search.trim());
          params.set('page', String(page));
          params.set('pageSize', String(pageSize));
          return api<ClaimPage>(`/submissions/claims?${params.toString()}`);
        })()
      ]);
      setTopBags(rank);
      setClaims(claimPage.items);
      setTotal(claimPage.totalCount);
    } catch (requestError) {
      message.error(requestError instanceof Error ? requestError.message : '加载认领数据失败');
    } finally {
      setLoading(false);
    }
  }, [message, page, pageSize, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <>
      <Card
        title={
          <Space>
            <CrownOutlined />
            <span>被认领最多的袋子</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Table<ClaimedBagRank>
          rowKey="bagId"
          dataSource={topBags}
          loading={loading}
          pagination={false}
          scroll={{ x: 720 }}
          columns={[
            {
              title: '排名',
              key: 'rank',
              width: 72,
              render: (_value, _record, index) =>
                index < 3 ? (
                  <Tag color={index === 0 ? 'gold' : index === 1 ? 'default' : 'orange'}>No.{index + 1}</Tag>
                ) : (
                  <Typography.Text type="secondary">{index + 1}</Typography.Text>
                )
            },
            {
              title: '袋子名称',
              dataIndex: 'bagName',
              key: 'bagName',
              render: (name: string, record) => (
                <Space size={8} wrap>
                  <Typography.Text strong>{name}</Typography.Text>
                  {record.brandName && <Tag>{record.brandName}</Tag>}
                </Space>
              )
            },
            {
              title: '认领次数',
              dataIndex: 'claimCount',
              key: 'claimCount',
              width: 110,
              sorter: (a, b) => a.claimCount - b.claimCount,
              render: (count: number) => <Typography.Text strong>{count}</Typography.Text>
            },
            {
              title: '最近认领',
              dataIndex: 'latestClaimedAt',
              key: 'latestClaimedAt',
              width: 180,
              render: (value: string) => new Date(value).toLocaleString('zh-CN')
            }
          ]}
        />
      </Card>

      <Card
        title={
          <Space>
            <TeamOutlined />
            <span>{`认领记录（共 ${total} 条）`}</span>
          </Space>
        }
        extra={
          <Space wrap>
            <Input.Search
              placeholder="搜索袋子 / 品牌 / 用户"
              allowClear
              style={{ width: 240 }}
              onSearch={(value) => {
                setSearch(value);
                setPage(1);
              }}
              onChange={(event) => {
                if (!event.target.value) {
                  setSearch('');
                  setPage(1);
                }
              }}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ClaimRow>
          rowKey="id"
          dataSource={claims}
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPageSize !== pageSize ? 1 : nextPage);
              setPageSize(nextPageSize);
            }
          }}
          scroll={{ x: 760 }}
          columns={[
            {
              title: '袋子名称',
              key: 'bagName',
              render: (_value, claim) => (
                <Space size={8} wrap>
                  <Typography.Text strong>{claim.bagName}</Typography.Text>
                  {claim.brandName && <Tag>{claim.brandName}</Tag>}
                </Space>
              )
            },
            {
              title: '用户',
              dataIndex: 'openidMasked',
              key: 'openidMasked',
              width: 180,
              render: (openid: string) => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {openid}
                </Typography.Text>
              )
            },
            {
              title: '认领时间',
              dataIndex: 'claimedAt',
              key: 'claimedAt',
              width: 180,
              sorter: (a, b) => new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime(),
              render: (value: string) => new Date(value).toLocaleString('zh-CN')
            }
          ]}
        />
      </Card>
    </>
  );
}
