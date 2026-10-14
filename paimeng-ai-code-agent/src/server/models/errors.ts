/** 运行期配置无效，而不是暂时读不到 DB。这类错误不能被旧快照掩盖。 */
export class ModelConfigInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigInvalidError';
  }
}
