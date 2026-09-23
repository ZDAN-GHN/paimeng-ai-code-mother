package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.dto.PlatformApplicationCreateRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformApplicationInitialRequirementRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRequirementCreateRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationManagementService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationInitialRequirementVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import com.zdan.paimengaicodebackend.service.UserService;
import com.mybatisflex.core.paginate.Page;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/platform/applications")
@Tag(name = "Platform Application", description = "Owner Application 管理与 Requirement 接收")
public class PlatformApplicationController {

    private final PlatformApplicationManagementService applicationManagementService;
    private final UserService userService;

    public PlatformApplicationController(
        PlatformApplicationManagementService applicationManagementService,
        UserService userService
    ) {
        this.applicationManagementService = applicationManagementService;
        this.userService = userService;
    }

    @PostMapping
    @Operation(summary = "创建 Application")
    public BaseResponse<PlatformApplicationVO> createApplication(
        @RequestBody PlatformApplicationCreateRequest request,
        HttpServletRequest servletRequest
    ) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        return ResultUtils.success(
            applicationManagementService.createApplication(loginUser(servletRequest), request.getName())
        );
    }

    @PostMapping("/initial-requirement")
    @Operation(summary = "从首页对话创建 Application 并提交首条 Requirement")
    public BaseResponse<PlatformApplicationInitialRequirementVO> createApplicationWithInitialRequirement(
        @RequestBody PlatformApplicationInitialRequirementRequest request,
        HttpServletRequest servletRequest
    ) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        return ResultUtils.success(
            applicationManagementService.createApplicationWithInitialRequirement(
                loginUser(servletRequest),
                request.getName(),
                request.getOriginalText()
            )
        );
    }

    @GetMapping
    @Operation(summary = "分页读取当前 Owner 创建的 Application")
    public BaseResponse<Page<PlatformApplicationVO>> listMyApplications(
        @RequestParam(defaultValue = "1") long pageNum,
        @RequestParam(defaultValue = "12") long pageSize,
        HttpServletRequest servletRequest
    ) {
        validatePage(pageNum, pageSize);
        return ResultUtils.success(
            applicationManagementService.listMyApplications(loginUser(servletRequest), pageNum, pageSize)
        );
    }

    @GetMapping("/{applicationId}")
    @Operation(summary = "读取 Application 管理状态")
    public BaseResponse<PlatformApplicationVO> getApplication(
        @Parameter(description = "Application ID", schema = @Schema(type = "string")) @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            applicationManagementService.getApplication(applicationId, loginUser(servletRequest))
        );
    }

    @PostMapping("/{applicationId}/requirements")
    @Operation(summary = "接收不可变 Requirement")
    public BaseResponse<PlatformRequirementVO> submitRequirement(
        @Parameter(description = "Application ID", schema = @Schema(type = "string")) @PathVariable Long applicationId,
        @RequestBody PlatformRequirementCreateRequest request,
        HttpServletRequest servletRequest
    ) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        return ResultUtils.success(
            applicationManagementService.submitRequirement(
                applicationId,
                loginUser(servletRequest),
                request.getOriginalText()
            )
        );
    }

    @GetMapping("/{applicationId}/requirements")
    @Operation(summary = "分页读取 Application 的不可变 Requirement 历史")
    public BaseResponse<Page<PlatformRequirementVO>> listRequirements(
        @Parameter(description = "Application ID", schema = @Schema(type = "string")) @PathVariable Long applicationId,
        @RequestParam(defaultValue = "1") long pageNum,
        @RequestParam(defaultValue = "20") long pageSize,
        HttpServletRequest servletRequest
    ) {
        validatePage(pageNum, pageSize);
        return ResultUtils.success(
            applicationManagementService.listRequirements(
                applicationId,
                loginUser(servletRequest),
                pageNum,
                pageSize
            )
        );
    }

    @GetMapping("/{applicationId}/requirements/{requirementId}")
    @Operation(summary = "读取 Requirement 等待归一化状态")
    public BaseResponse<PlatformRequirementVO> getRequirement(
        @Parameter(description = "Application ID", schema = @Schema(type = "string")) @PathVariable Long applicationId,
        @Parameter(description = "Requirement ID", schema = @Schema(type = "string")) @PathVariable Long requirementId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            applicationManagementService.getRequirement(
                applicationId,
                requirementId,
                loginUser(servletRequest)
            )
        );
    }

    @PostMapping("/{applicationId}/archive")
    @Operation(summary = "归档 Application")
    public BaseResponse<PlatformApplicationVO> archiveApplication(
        @Parameter(description = "Application ID", schema = @Schema(type = "string")) @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            applicationManagementService.archiveApplication(applicationId, loginUser(servletRequest))
        );
    }

    private User loginUser(HttpServletRequest request) {
        return userService.getLoginUser(request);
    }

    private void validatePage(long pageNum, long pageSize) {
        if (pageNum <= 0 || pageSize <= 0 || pageSize > 20) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "分页参数无效");
        }
    }
}
