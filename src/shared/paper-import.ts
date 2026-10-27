export interface PaperImportFields {
  title: string;
  authors: string;
  year?: number;
  publication: string;
  doi: string;
  url: string;
}

export type PaperMetadataSource = 'embedded' | 'first-page' | 'filename' | 'model';

export interface PaperMetadataSuggestion {
  fields: PaperImportFields;
  sources: Partial<Record<keyof PaperImportFields, PaperMetadataSource>>;
  warnings: string[];
  firstPageText: string;
  pageCount: number;
  modelLabel?: string;
}

export interface PaperPdfImportRequest {
  requestId: string;
  workspaceId: string;
  dataDirectory: string;
  name: string;
  base64: string;
  fields: PaperImportFields;
}
