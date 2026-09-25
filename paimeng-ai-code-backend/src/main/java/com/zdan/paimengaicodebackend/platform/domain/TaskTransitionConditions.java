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
