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
}
