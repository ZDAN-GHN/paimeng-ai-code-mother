package com.zdan.paimengaicodemother.generator;

import cn.hutool.core.lang.Dict;
import cn.hutool.setting.yaml.YamlUtil;
import com.mybatisflex.codegen.Generator;
import com.mybatisflex.codegen.config.ColumnConfig;
import com.mybatisflex.codegen.config.GlobalConfig;
import com.zaxxer.hikari.HikariDataSource;

import java.util.Map;

/**
 * MybatisFlex 代码生成器
 *
 * @author LXH
 */
public class MybatisFlexCodeGenerator {

    // 要生成的表名称
    private static final String[] TABLE_NAMES = {"app"};

    public static void main(String[] args) {
        // 获取数据源元信息
        Dict dict = YamlUtil.loadByPath("application.yml");
        Map<String, Object> dataSourceConfig = dict.getByPath("spring.datasource");
        String url = String.valueOf(dataSourceConfig.get("url"));
        String username = String.valueOf(dataSourceConfig.get("username"));
        String password = String.valueOf(dataSourceConfig.get("password"));

        // 配置数据源
        HikariDataSource dataSource = new HikariDataSource();
        dataSource.setJdbcUrl(url);
        dataSource.setUsername(username);
        dataSource.setPassword(password);

        //创建配置内容
        GlobalConfig globalConfig = createGlobalConfig();

        //通过 datasource 和 globalConfig 创建代码生成器
        Generator generator = new Generator(dataSource, globalConfig);

        //生成代码
        generator.generate();
    }


    public static GlobalConfig createGlobalConfig() {
        // 创建配置内容
        GlobalConfig globalConfig = new GlobalConfig();

        // 设置根包，考虑代码维护，优先选择生成到临时目录再一个个加入到已有包中
        globalConfig.getPackageConfig()
                .setBasePackage("com.zdan.paimengaicodemother.genresult");

        // 设置表前缀和只生成哪些表，setGenerateTable 未配置时，生成所有表
        final String isDelete = "isDelete";
        globalConfig.getStrategyConfig()
                // .setTablePrefix("tb_")
                .setGenerateTable(TABLE_NAMES)
                .setLogicDeleteColumn(isDelete);

        // 设置生成 entity 并启用 Lombok
        globalConfig.enableEntity()
                .setWithLombok(true)
                .setJdkVersion(21);

        // 设置生成 mapper 以及对应 xml
        globalConfig.enableMapper();
        globalConfig.enableMapperXml();

        // 设置生成 service 以及对应 impl
        globalConfig.enableService();
        globalConfig.enableServiceImpl();

        // 设置生成 controller
        globalConfig.enableController();

        // 设置生成注释，例如生成的时间和作者，避免后续多余的代码改动
        globalConfig.getJavadocConfig()
                .setAuthor("LXH")
                // 不生成时间
                .setSince("");

        return globalConfig;
    }
}