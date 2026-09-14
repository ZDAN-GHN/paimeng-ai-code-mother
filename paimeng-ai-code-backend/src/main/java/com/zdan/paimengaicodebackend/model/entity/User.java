package com.zdan.paimengaicodebackend.model.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.io.Serializable;
import java.time.LocalDateTime;

import java.io.Serial;

import com.mybatisflex.core.keygen.KeyGenerators;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;


@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table("user")
public class User implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;


    @Column("userAccount")
    private String userAccount;


    @Column("userPassword")
    private String userPassword;


    @Column("userName")
    private String userName;


    @Column("userAvatar")
    private String userAvatar;


    @Column("userProfile")
    private String userProfile;


    @Column("userRole")
    private String userRole;


    @Column("credits")
    private Integer credits;


    @Column("editTime")
    private LocalDateTime editTime;


    @Column("createTime")
    private LocalDateTime createTime;


    @Column("updateTime")
    private LocalDateTime updateTime;


    @Column(value = "isDelete", isLogicDelete = true)
    private Integer isDelete;

}
