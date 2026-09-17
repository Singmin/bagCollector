declare module 'qcloud-cos-sts' {
  const STS: {
    getCredential(options: unknown, callback: (error: Error | null, credential: any) => void): void;
  };
  export default STS;
}
