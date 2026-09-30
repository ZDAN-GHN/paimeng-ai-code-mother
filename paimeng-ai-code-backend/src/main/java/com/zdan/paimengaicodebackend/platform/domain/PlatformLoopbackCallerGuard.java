package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * 回环调用方围栏（Issue #80 / T-08）
 *
 * <p>抽成共用组件是因为 {@code /platform/runs/execution/**} 与
 * {@code /platform/agent/work/**} 处在同一条信任边界上，必须用同一条判据；
 * 两处各写一份迟早会只改一处。
 *
 * <p>判据取 {@code getRemoteAddr()}——TCP 对端地址，不是任何可伪造的请求头，
 * {@code X-Forwarded-For} 在此一律不参与判断。放到代理之后会让对端变成代理本身，
 * 那种部署形态需要的是真正的鉴权，而不是把这里改宽。
 */
@Component
public class PlatformLoopbackCallerGuard {

    /** 回环地址的全部表示形式。IPv4、IPv6 与 IPv4-mapped IPv6 都要覆盖。 */
    private static final Set<String> LOOPBACK_ADDRESSES = Set.of(
        "127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "::1",
        "::ffff:127.0.0.1"
    );

    public void requireLoopbackCaller(HttpServletRequest request) {
        String remoteAddress = request == null ? null : request.getRemoteAddr();
        if (remoteAddress == null || !LOOPBACK_ADDRESSES.contains(remoteAddress)) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "受控执行端点只接受本机调用");
        }
    }
}
