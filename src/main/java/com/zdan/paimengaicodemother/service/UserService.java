package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodemother.model.dto.user.UserQueryRequest;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.vo.LoginUserVO;
import com.zdan.paimengaicodemother.model.vo.UserVO;
import jakarta.servlet.http.HttpServletRequest;

import java.util.List;

/**
 * 用户 服务层
 *
 * @author LXH
 */
public interface UserService extends IService<User> {

    /**
     * 获取查询条件
     *
     * @param userQueryRequest 用户查询请求
     * @return 查询条件
     */
    QueryWrapper getQueryWrapper(UserQueryRequest userQueryRequest);

    /**
     * 获取视图对象列表
     *
     * @param userList 用户实体列表
     * @return 用户视图对象列表
     */
    List<UserVO> getUserVOList(List<User> userList);

    /**
     * 获取视图对象
     *
     * @param user 用户实体
     * @return 用户视图对象
     */
    UserVO getUserVO(User user);

    /**
     * 用户注销（退出登录）
     *
     * @param request http 请求
     * @return 注销结果，true 为成功
     */
    boolean userLogout(HttpServletRequest request);

    /**
     * 获取当前登录用户
     *
     * @param request http 请求
     * @return 用户实体
     */
    User getLoginUser(HttpServletRequest request);

    /**
     * 用户登录
     *
     * @param userAccount     用户账户
     * @param encryptPassword 用户密码
     * @param request         http 请求
     * @return 已登录用户视图
     */
    LoginUserVO userLogin(String userAccount, String encryptPassword, HttpServletRequest request);

    /**
     * 获取脱敏的已登录用户信息
     *
     * @param user 用户实体
     * @return 已登录用户视图
     */
    LoginUserVO getLoginUserVO(User user);

    /**
     * 获取加密后的密码
     *
     * @param userPassword 用户密码
     * @return 加密后的密码
     */
    String getEncryptPassword(String userPassword);

    /**
     * 用户注册方法
     *
     * @param userAccount   用户账户
     * @param userPassword  用户密码
     * @param checkPassword 校验密码
     * @return 新用户 id
     */
    long userRegister(String userAccount, String userPassword, String checkPassword);
}