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

    /**
     * {@code validated -> released} 的首次发布意图。
     *
     * <p>AD-011：首次 validated 版本自动发布，之后的版本必须由 Owner 确认。调用方只能表达
     * 「我打算做首次发布」这个意图，真正的前置条件由
     * {@link #withFirstReleaseFact(boolean)} 用持久事实覆盖。
     */
    static TaskTransitionConditions forFirstRelease() {
        return new TaskTransitionConditions(false, false, false, true, false, false, false);
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

    /**
     * 用 Platform 侧的真实 Release 事实覆盖调用方自报的「首次发布」。
     *
     * <p>AD-011 的前置条件与 Lease、Owner 重试是同一类：任何内部调用方都能传
     * {@code firstRelease=true} 把一个后续版本自动推上线。Platform 必须自己确认「这个版本是该
     * Application 的第一个固定版本」，而不是相信入参。
     */
    TaskTransitionConditions withFirstReleaseFact(boolean persistedFirstRelease) {
        return new TaskTransitionConditions(
            baselineFrozen,
            runStoppedAndLeaseReleased,
            retryRequestedByOwner,
            persistedFirstRelease,
            ownerConfirmedPublish,
            runCreatedAndLeaseGranted,
            validationPassed
        );
    }
}
