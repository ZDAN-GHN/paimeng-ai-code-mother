// @ts-ignore
/* eslint-disable */
import request from '@/request'

/** 分页读取当前 Owner 创建的 Application GET /platform/applications */
export async function listMyApplications(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.listMyApplicationsParams,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponsePagePlatformApplicationVO>('/platform/applications', {
    method: 'GET',
    params: {
      // pageNum has a default value: 1
      pageNum: '1',
      // pageSize has a default value: 12
      pageSize: '12',
      ...params,
    },
    ...(options || {}),
  })
}

/** 创建 Application POST /platform/applications */
export async function createApplication(
  body: API.PlatformApplicationCreateRequest,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponsePlatformApplicationVO>('/platform/applications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  })
}

/** 读取 Application 管理状态 GET /platform/applications/${param0} */
export async function getApplication(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getApplicationParams,
  options?: { [key: string]: any }
) {
  const { applicationId: param0, ...queryParams } = params
  return request<API.BaseResponsePlatformApplicationVO>(`/platform/applications/${param0}`, {
    method: 'GET',
    params: { ...queryParams },
    ...(options || {}),
  })
}

/** 归档 Application POST /platform/applications/${param0}/archive */
export async function archiveApplication(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.archiveApplicationParams,
  options?: { [key: string]: any }
) {
  const { applicationId: param0, ...queryParams } = params
  return request<API.BaseResponsePlatformApplicationVO>(
    `/platform/applications/${param0}/archive`,
    {
      method: 'POST',
      params: { ...queryParams },
      ...(options || {}),
    }
  )
}

/** 分页读取 Application 的不可变 Requirement 历史 GET /platform/applications/${param0}/requirements */
export async function listRequirements(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.listRequirementsParams,
  options?: { [key: string]: any }
) {
  const { applicationId: param0, ...queryParams } = params
  return request<API.BaseResponsePagePlatformRequirementVO>(
    `/platform/applications/${param0}/requirements`,
    {
      method: 'GET',
      params: {
        // pageNum has a default value: 1
        pageNum: '1',
        // pageSize has a default value: 20
        pageSize: '20',
        ...queryParams,
      },
      ...(options || {}),
    }
  )
}

/** 接收不可变 Requirement POST /platform/applications/${param0}/requirements */
export async function submitRequirement(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.submitRequirementParams,
  body: API.PlatformRequirementCreateRequest,
  options?: { [key: string]: any }
) {
  const { applicationId: param0, ...queryParams } = params
  return request<API.BaseResponsePlatformRequirementVO>(
    `/platform/applications/${param0}/requirements`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      params: { ...queryParams },
      data: body,
      ...(options || {}),
    }
  )
}

/** 读取 Requirement 等待归一化状态 GET /platform/applications/${param0}/requirements/${param1} */
export async function getRequirement(
  // 叠加生成的Param类型 (非body参数swagger默认没有生成对象)
  params: API.getRequirementParams,
  options?: { [key: string]: any }
) {
  const { applicationId: param0, requirementId: param1, ...queryParams } = params
  return request<API.BaseResponsePlatformRequirementVO>(
    `/platform/applications/${param0}/requirements/${param1}`,
    {
      method: 'GET',
      params: { ...queryParams },
      ...(options || {}),
    }
  )
}

/** 从首页对话创建 Application 并提交首条 Requirement POST /platform/applications/initial-requirement */
export async function createApplicationWithInitialRequirement(
  body: API.PlatformApplicationInitialRequirementRequest,
  options?: { [key: string]: any }
) {
  return request<API.BaseResponsePlatformApplicationInitialRequirementVO>(
    '/platform/applications/initial-requirement',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      data: body,
      ...(options || {}),
    }
  )
}
