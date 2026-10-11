import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ put: vi.fn((_params, callback) => callback(null, {})), remove: vi.fn((_params, callback) => callback(null, { Error: [{ Key: 'a', Code: 'AccessDenied' }] })) }));
vi.mock('../src/config.js', () => ({ config: { STORAGE_DRIVER: 'cos', LOCAL_STORAGE_PATH: '.runtime/storage', COS_SECRET_ID: 'test', COS_SECRET_KEY: 'test', COS_BUCKET: 'test-123', COS_REGION: 'ap-test' } }));
vi.mock('cos-nodejs-sdk-v5', () => ({ default: class { putObject = mocks.put; deleteMultipleObject = mocks.remove; } }));
import { putObject as writeSampleObject, deleteObjects as deleteSampleObjects } from '../src/object-store.js';
describe('learning object storage', () => {
  it('overrides inherited public permissions and cache policy for sample JPEGs', async () => {
    await writeSampleObject('learning-samples/a/image.jpg', Buffer.from('sample'), 'image/jpeg', true);
    expect(mocks.put.mock.calls[0]![0]).toEqual(expect.objectContaining({ ACL: 'private', CacheControl: 'private, no-store', ContentLength: 6 }));
  });
  it('does not report a partial COS deletion as successful', async () => {
    await expect(deleteSampleObjects(['a'])).rejects.toThrow('partial deletion');
  });
});
