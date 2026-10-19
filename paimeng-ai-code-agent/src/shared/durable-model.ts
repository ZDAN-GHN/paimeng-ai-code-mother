import { z } from 'zod';


export const generationModelAlias = 'codegen.default';

export const envModelProviderId = 'durable';

/** 一次生成的公开身份：进记账行与前端，不含密钥。 */
export const generationModelIdentitySchema = z.object({
	alias: z.string(),
	providerId: z.string().nullable(),
	modelName: z.string().nullable(),
	apiFormat: z.string().nullable(),
});
export type GenerationModelIdentity = z.infer<typeof generationModelIdentitySchema>;

/**
 * `POST /model` 的响应：本次生成已固定的模型绑定。
 *
 * `token` 是不透明句柄（不是密钥）：`POST /conversations` 与 `POST /submit` 带上它，harness 用准入时
 * 解析好的那一份配置，所以预检与提交之间改库不会让这次生成换到另一个模型。
 */
export const modelAdmissionSchema = z.object({
	token: z.string().nullable(),
	identity: generationModelIdentitySchema,
	imageInput: z.boolean(),
	thinkingLevel: z.string(),
});
export type ModelAdmission = z.infer<typeof modelAdmissionSchema>;

/** harness 的模型错误响应：状态码在产品错误码上，文案可直接给用户（不含密钥与上游报文）。 */
export const harnessModelFailureSchema = z.object({ error: z.string(), code: z.number() });

/** `GET /model` 的响应：某会话当前这次生成实际用的模型（只读，记账与验证用）。 */
export const conversationModelSchema = z.object({
	model: z.object({ provider: z.string(), modelId: z.string() }).nullable(),
	identity: generationModelIdentitySchema.nullable(),
	thinkingLevel: z.string().nullable(),
});
export type ConversationModel = z.infer<typeof conversationModelSchema>;
