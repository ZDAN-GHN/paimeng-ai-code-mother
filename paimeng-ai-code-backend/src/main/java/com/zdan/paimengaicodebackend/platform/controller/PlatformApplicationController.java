package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.dto.PlatformApplicationCreateRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRequirementCreateRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationManagementService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import com.zdan.paimengaicodebackend.service.UserService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
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

    @GetMapping("/{applicationId}")
    @Operation(summary = "读取 Application 管理状态")
    public BaseResponse<PlatformApplicationVO> getApplication(
        @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            applicationManagementService.getApplication(applicationId, loginUser(servletRequest))
        );
    }

    @PostMapping("/{applicationId}/requirements")
    @Operation(summary = "接收不可变 Requirement")
    public BaseResponse<PlatformRequirementVO> submitRequirement(
        @PathVariable Long applicationId,
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

    @GetMapping("/{applicationId}/requirements/{requirementId}")
    @Operation(summary = "读取 Requirement 等待归一化状态")
    public BaseResponse<PlatformRequirementVO> getRequirement(
        @PathVariable Long applicationId,
        @PathVariable Long requirementId,
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
        @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            applicationManagementService.archiveApplication(applicationId, loginUser(servletRequest))
        );
    }

    private User loginUser(HttpServletRequest request) {
        return userService.getLoginUser(request);
    }
}
