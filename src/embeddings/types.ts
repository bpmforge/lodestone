export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderMeta {
  name: string;
  dim: number;
}
