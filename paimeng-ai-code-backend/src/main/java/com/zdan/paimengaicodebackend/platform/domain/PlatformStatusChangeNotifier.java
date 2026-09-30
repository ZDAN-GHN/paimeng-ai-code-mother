package com.zdan.paimengaicodebackend.platform.domain;

import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Owner 状态流的通知时机（Issue #80 / Slice 2）
 *
 * <p>抽出来是因为「提交后才通知」这条规则不该只存在于某一个类里：任何改变 Owner 可见
 * 状态的写入都要遵守它。提前通知会让订阅端在同一事务里读到未提交的行，于是 Owner 先看到一个
 * 随后回滚的状态——宁可晚推一次，也不能说出一个不成立的事实。
 */
@Component
public class PlatformStatusChangeNotifier {

    private final PlatformStatusStreamRegistry streamRegistry;

    public PlatformStatusChangeNotifier(PlatformStatusStreamRegistry streamRegistry) {
        this.streamRegistry = streamRegistry;
    }

    public void notifyAfterCommit(long applicationId) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            streamRegistry.notifyChanged(applicationId);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                streamRegistry.notifyChanged(applicationId);
            }
        });
    }
}
