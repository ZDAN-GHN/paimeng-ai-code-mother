package com.zdan.paimengaicodemother.controller;

import com.zdan.paimengaicodemother.annotation.AuthCheck;
import com.zdan.paimengaicodemother.common.BaseResponse;
import com.zdan.paimengaicodemother.common.ResultUtils;
import com.zdan.paimengaicodemother.constant.UserConstant;
import com.zdan.paimengaicodemother.model.dto.user.CreditRechargeRequest;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.CreditService;
import com.zdan.paimengaicodemother.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 积分（credit）控制层（Issue #10）
 * 冻结/结算/退款经 Java 内部 API 由 TS Agent 触发（见 GenerationRunController / CreditService）；
 * 本组端点面向用户：管理员手动充值（架构 §7 MVP 后台充值）+ 当前登录用户余额查询。
 *
 * @author LXH
 */
@RestController
@RequestMapping("/credit")
public class CreditController {

    private final CreditService creditService;
    private final UserService userService;

    public CreditController(CreditService creditService, UserService userService) {
        this.creditService = creditService;
        this.userService = userService;
    }

    /**
     * 管理员手动充值（架构 §7 MVP 后台充值）：给指定用户增加积分余额
     *
     * @param request 充值请求（userId + credits）
     * @return 充值成功
     */
    @PostMapping("/recharge")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> recharge(@RequestBody CreditRechargeRequest request) {
        return ResultUtils.success(creditService.recharge(request.getUserId(), request.getCredits()));
    }

    /**
     * 查询当前登录用户积分余额（前端 #13 积分展示的后端支持）
     *
     * @param request Http 请求（取登录态 userId）
     * @return 余额
     */
    @GetMapping("/balance")
    public BaseResponse<Integer> getBalance(HttpServletRequest request) {
        User loginUser = userService.getLoginUser(request);
        return ResultUtils.success(creditService.getBalance(loginUser.getId()));
    }
}
