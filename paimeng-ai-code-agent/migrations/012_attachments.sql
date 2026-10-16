-- 用户随消息上传的图片附件（v1：只支持随消息发送，不做用途选择/绑定/回收）。
-- 字符串列不写 COLLATE，继承库默认 utf8mb4_0900_ai_ci，避免与 ts_generation/ts_app 的列比较时报 ER_CANT_AGGREGATE_2COLLATIONS。
CREATE TABLE ts_attachment (
  id VARCHAR(36) PRIMARY KEY,
  ownerUserId BIGINT UNSIGNED NOT NULL,
  appId BIGINT UNSIGNED NULL,
  originalName VARCHAR(256) NOT NULL,
  mediaType VARCHAR(32) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  width INT UNSIGNED NOT NULL,
  height INT UNSIGNED NOT NULL,
  hash CHAR(64) NOT NULL,
  objectKey VARCHAR(512) NOT NULL,
  previewKey VARCHAR(512) NOT NULL,
  createTime DATETIME(3) NOT NULL,
  updateTime DATETIME(3) NOT NULL,
  KEY idx_attachment_owner (ownerUserId),
  KEY idx_attachment_app (appId)
);
