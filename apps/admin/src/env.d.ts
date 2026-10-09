/// <reference types="vite/client" />

/** 构建时注入的版本号：生产为 git commit SHA，本地为短哈希或 dev。 */
declare const __VERSION__: string;
/** 构建时注入的构建时间（ISO 8601 字符串）。 */
declare const __BUILD_TIME__: string;
