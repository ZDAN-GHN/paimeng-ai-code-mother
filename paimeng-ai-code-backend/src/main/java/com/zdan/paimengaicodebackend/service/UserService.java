package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.user.UserQueryRequest;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.vo.LoginUserVO;
import com.zdan.paimengaicodebackend.model.vo.UserVO;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;

public interface UserService extends IService<User> {
    QueryWrapper getQueryWrapper(UserQueryRequest userQueryRequest);

    List<UserVO> getUserVOList(List<User> userList);

    UserVO getUserVO(User user);

    boolean userLogout(HttpServletRequest request);

    User getLoginUser(HttpServletRequest request);

    LoginUserVO userLogin(String userAccount, String encryptPassword, HttpServletRequest request);

    LoginUserVO getLoginUserVO(User user);

    String getEncryptPassword(String userPassword);

    long userRegister(String userAccount, String userPassword, String checkPassword);

    int deductCredits(Long userId, int amount);

    int addCredits(Long userId, int amount);
}
