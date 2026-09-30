package com.zdan.paimengaicodebackend.platform.domain;

record TaskTransitionConditions(
    boolean baselineFrozen,
    boolean runStoppedAndLeaseReleased,
    boolean retryRequestedByOwner,
    boolean firstRelease,
    boolean ownerConfirmedPublish,
    boolean runCreatedAndLeaseGranted,
    boolean validationPassed
) {
    static TaskTransitionConditions none() {
        return new TaskTransitionConditions(false, false, false, false, false, false, false);
    }

    TaskTransitionConditions withPersistedBaseline(boolean persistedBaselineFrozen) {
        return new TaskTransitionConditions(
            persistedBaselineFrozen,
            runStoppedAndLeaseReleased,
            retryRequestedByOwner,
            firstRelease,
            ownerConfirmedPublish,
            runCreatedAndLeaseGranted,
            validationPassed
        );
    }

    /**
     * 用 Platform 侧的真实 Owner 重试事实覆盖调用方自报的值。
     *
     * <p>D-06：`failed -> ready` 的前置是「Owner 显式请求重试」。它此前与 Lease 前置条件
     * 是同一类漏洞：任何内部调用方都能传 {@code actor=OWNER} 加一个重试 reasonCode 伪造
     * 一次 Owner 请求。Platform 必须自己查「有没有被受理过的重试行」，而不是相信入参。
     */
    TaskTransitionConditions withOwnerRetryFact(boolean persistedOwnerRetryRequested) {
        return new TaskTransitionConditions(
            baselineFrozen,
            runStoppedAndLeaseReleased,
            persistedOwnerRetryRequested,
            firstRelease,
            ownerConfirmedPublish,
            runCreatedAndLeaseGranted,
            validationPassed
        );
    }

    /**
     * 用 Platform 侧的真实 Lease 与 Run 事实覆盖调用方自报的值。
     *
     * <p>D-06：Lease 归属由 Platform 裁决，调用方不能自称「已持有 Lease」或「已释放」，
     * 否则状态机的 Lease 前置条件可被绕过。
     */
    TaskTransitionConditions withLeaseFacts(
        boolean actualRunCreatedAndLeaseGranted,
        boolean actualRunStoppedAndLeaseReleased
    ) {
        return new TaskTransitionConditions(
            baselineFrozen,
            actualRunStoppedAndLeaseReleased,
            retryRequestedByOwner,
            firstRelease,
            ownerConfirmedPublish,
            actualRunCreatedAndLeaseGranted,
            validationPassed
        );
    }
}
