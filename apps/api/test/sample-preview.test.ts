import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ url: vi.fn((_params, callback) => callback(null, { Url: 'https://signed.test/preview' })) }));
vi.mock('../src/common/env.js', () => ({ env: () => ({ STORAGE_DRIVER: 'cos', LOCAL_STORAGE_PATH: '.runtime/storage',
  ASSET_URL_MODE: 'public', API_PUBLIC_URL: 'https://api.test', COS_SECRET_ID: 'test', COS_SECRET_KEY: 'test', COS_BUCKET: 'test-123', COS_REGION: 'ap-test', COS_PUBLIC_HOST: 'https://cdn.test' }) }));
vi.mock('cos-nodejs-sdk-v5', () => ({ default: class { getObjectUrl = mocks.url; } }));
import { CosService } from '../src/assets/cos.service.js';
describe('private learning previews', () => {
  it('always signs private samples against origin even when display assets are public/CDN', async () => {
    const cos = new CosService();
    expect(await cos.signedUrl('official/bag/display.jpg')).toBe('https://cdn.test/official/bag/display.jpg');
    expect(mocks.url).not.toHaveBeenCalled();
    expect(await cos.privateSignedUrl('learning-samples/sample/image.jpg')).toBe('https://signed.test/preview');
    expect(mocks.url.mock.calls[0]![0]).toEqual(expect.objectContaining({ Key: 'learning-samples/sample/image.jpg', Sign: true, Expires: 300 }));
    expect(mocks.url.mock.calls[0]![0]).not.toHaveProperty('Domain');
  });
});
