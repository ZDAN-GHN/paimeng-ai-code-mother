package com.zdan.paimengaicodebackend.platform.validation;

import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 权威验证的轮询驱动（Issue #80 / T-08）
 *
 * <p>验证是 Platform 内部职责，不能由 Agent 触发（AD-009），因此用 Platform 自己的
 * 调度器推进。轮询间隔只是让队列尽快被消费，不改变任何状态语义。
 */
@Slf4j
@Component
@ConditionalOnProperty(prefix = "platform.execution", name = "enabled", havingValue = "true")
public class PlatformValidationScheduler {

    private final PlatformValidationWorker worker;

    public PlatformValidationScheduler(PlatformValidationWorker worker) {
        this.worker = worker;
    }

    @Scheduled(fixedDelayString = "${platform.validation.poll-interval-ms:5000}")
    public void drainOnce() {
        try {
            Optional<PlatformValidationWorker.Outcome> settled = worker.settleNext();
            settled.ifPresent(outcome -> log.info(
                "Platform validation settled, runId: {}, state: {}, reasonCode: {}, result: success",
                outcome.runId(), outcome.state(), outcome.reasonCode()));
        } catch (RuntimeException failure) {
            // 单次结算失败不终止轮询：队列行仍是 RUNNING，租约到期后会被重新领取。
            log.error("Platform validation settlement failed, result: failure", failure);
        }
    }
}
