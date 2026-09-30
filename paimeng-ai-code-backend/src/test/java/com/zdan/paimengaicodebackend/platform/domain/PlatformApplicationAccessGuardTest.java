package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import org.junit.jupiter.api.Test;

/**
 * 「谁能管理哪个 Application」只有这一处实现，Owner 状态读取与阻断答复都依赖它。
 * 因此这里同时覆盖读与写两种门槛：归档后允许读、不允许接受新需求或答复。
 */
class PlatformApplicationAccessGuardTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long OWNER_ID = 377708067863715840L;

    private final AppMapper appMapper = mock(AppMapper.class);
    private final PlatformLogicalRelationValidator relationValidator = mock(PlatformLogicalRelationValidator.class);
    private final PlatformApplicationAccessGuard guard =
        new PlatformApplicationAccessGuard(appMapper, relationValidator);

    @Test
    void ownerMayManageOwnApplication() {
        App application = application("ACTIVE");
        when(relationValidator.requireApplication(APPLICATION_ID)).thenReturn(application);

        assertEquals(application, guard.requireManaged(APPLICATION_ID, user(OWNER_ID, "user")));
    }

    @Test
    void systemAdministratorMayManageAnyApplication() {
        App application = application("ACTIVE");
        when(relationValidator.requireApplication(APPLICATION_ID)).thenReturn(application);

        assertEquals(application, guard.requireManaged(APPLICATION_ID, user(999L, "admin")));
    }

    @Test
    void nonOwnerIsRejectedBeforeAnyApplicationFactIsUsed() {
        when(relationValidator.requireApplication(APPLICATION_ID)).thenReturn(application("ACTIVE"));

        BusinessException rejection = assertThrows(BusinessException.class,
            () -> guard.requireManaged(APPLICATION_ID, user(999L, "user")));

        assertEquals(40101, rejection.getCode());
    }

    @Test
    void archivedApplicationStaysReadableButStopsAcceptingWork() {
        when(relationValidator.requireApplication(APPLICATION_ID)).thenReturn(application("ARCHIVED"));

        assertEquals("ARCHIVED", guard.requireReadable(APPLICATION_ID, user(OWNER_ID, "user")).getLifecycleStatus());
        assertThrows(BusinessException.class, () -> guard.requireManaged(APPLICATION_ID, user(OWNER_ID, "user")));
    }

    @Test
    void unauthenticatedCallerIsRejected() {
        assertThrows(BusinessException.class, () -> guard.requireReadable(APPLICATION_ID, null));
        assertThrows(BusinessException.class, () -> guard.requireReadable(APPLICATION_ID, new User()));
    }

    @Test
    void invalidApplicationIdIsRejectedBeforeLookup() {
        assertThrows(BusinessException.class, () -> guard.requireReadable(0L, user(OWNER_ID, "user")));
        assertThrows(BusinessException.class, () -> guard.requireReadable(null, user(OWNER_ID, "user")));
    }

    @Test
    void actorIsDerivedFromRoleNotFromClientClaim() {
        assertEquals(PlatformActor.OWNER, guard.actorFor(user(OWNER_ID, "user")));
        assertEquals(PlatformActor.SYSTEM_ADMINISTRATOR, guard.actorFor(user(999L, "admin")));
    }

    private App application(String lifecycleStatus) {
        App application = new App();
        application.setId(APPLICATION_ID);
        application.setUserId(OWNER_ID);
        application.setLifecycleStatus(lifecycleStatus);
        return application;
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(role);
        return user;
    }
}
