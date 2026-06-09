declare module "mammoth" {
  interface Result {
    value: string;
    messages: unknown[];
  }
  interface BufferInput {
    buffer: Buffer;
  }
  interface ArrayBufferInput {
    arrayBuffer: ArrayBuffer;
  }
  const mammoth: {
    extractRawText(input: BufferInput | ArrayBufferInput): Promise<Result>;
  };
  export = mammoth;
}
