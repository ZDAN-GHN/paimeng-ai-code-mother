package com.zdan.paimengaicodebackend.controller;

import com.zdan.paimengaicodebackend.annotation.AuthCheck;
import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.model.dto.user.CreditRechargeRequest;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.service.CreditService;
import com.zdan.paimengaicodebackend.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;


@RestController
@RequestMapping("/credit")
public class CreditController {

    private final CreditService creditService;
    private final UserService userService;

    public CreditController(CreditService creditService, UserService userService) {
        this.creditService = creditService;
        this.userService = userService;
    }


    @PostMapping("/recharge")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> recharge(@RequestBody CreditRechargeRequest request) {
        creditService.recharge(request.getUserId(), request.getCredits());
        return ResultUtils.success(true);
    }


    @GetMapping("/balance")
    public BaseResponse<Integer> getBalance(HttpServletRequest request) {
        User loginUser = userService.getLoginUser(request);
        return ResultUtils.success(creditService.getBalance(loginUser.getId()));
    }
}
