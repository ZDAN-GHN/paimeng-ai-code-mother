package com.zdan.paimengaicodebackend.platform.domain;

public record TaskTransitionConditions(
    boolean baselineFrozen,
    boolean runStoppedAndLeaseReleased,
    boolean retryRequestedByOwner,
    boolean firstRelease,
    boolean ownerConfirmedPublish
) {
    public static TaskTransitionConditions none() {
        return new TaskTransitionConditions(false, false, false, false, false);
    }
}
