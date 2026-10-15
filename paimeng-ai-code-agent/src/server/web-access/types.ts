/** 联网工具的错误码与结果状态。错误码面向模型和日志，不承载上游响应正文。 */
export const webAccessErrorCodes = ['auth', 'quota', 'timeout', 'unavailable', 'blocked-url', 'invalid-response', 'budget-exceeded', 'too-large', 'unsupported', 'not-found'] as const;

export type WebAccessErrorCode = (typeof webAccessErrorCodes)[number];

export class WebAccessError extends Error {
  readonly code: WebAccessErrorCode;
  readonly status: number | null;

  constructor(code: WebAccessErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'WebAccessError';
    this.code = code;
    this.status = status;
  }
}

export type ToolStatus<T> = { status: 'ok'; data: T } | { status: 'empty'; message: string } | { status: 'error'; code: WebAccessErrorCode; message: string };

export function toolOk<T>(data: T): ToolStatus<T> {
  return { status: 'ok', data };
}

export function toolEmpty<T>(message: string): ToolStatus<T> {
  return { status: 'empty', message };
}

/** 把任意异常收敛成模型可读的错误状态；未知异常不外泄原始信息。 */
export function toolFailure<T>(error: unknown): ToolStatus<T> {
  if (error instanceof WebAccessError) return { status: 'error', code: error.code, message: error.message };
  return { status: 'error', code: 'unavailable', message: '联网工具调用失败，请稍后重试或改用其他方式' };
}

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebSearchData = {
  provider: string;
  query: string;
  retrievedAt: string;
  results: WebSearchResult[];
};

export type WebPageData = {
  provider: string;
  requestedUrl: string;
  finalUrl: string | null;
  title: string;
  content: string;
  truncated: boolean;
  warnings: string[];
  retrievedAt: string;
};

export type ImageCandidateView = {
  candidateId: string;
  title: string;
  /** 服务商的图片描述；机器翻译，仅作参考。 */
  description: string | null;
  sourcePage: string;
  /** false 表示只有图片地址、没有来源页，不能当成出处引用。 */
  sourceIsPage: boolean;
  creator: string | null;
  license: string | null;
  licenseUrl: string | null;
  licenseKnown: boolean;
  width: number | null;
  height: number | null;
  attribution: string | null;
};

export type ImageSearchData = {
  provider: string;
  query: string;
  retrievedAt: string;
  strictLicense: boolean;
  notice: string;
  candidates: ImageCandidateView[];
};

export type ImportedImageData = {
  path: string;
  src: string;
  bytes: number;
  format: string;
  sourcePage: string;
  creator: string | null;
  license: string | null;
  licenseUrl: string | null;
  licenseKnown: boolean;
  attribution: string | null;
  creditsPath: string | null;
};
