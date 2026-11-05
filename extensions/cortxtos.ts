// cortxtos 占位 extension：证明 Pi package 被加载（正式 kb-search/守卫在票 03/04）
// 宿主在运行时注入 pi 实例；此处用结构化最小类型，避免对宿主包的编译期依赖
interface ExtensionCtx {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}
interface ExtensionAPI {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: ExtensionCtx) => Promise<void> | void },
  ): void;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cortxtos", {
    description: "CortxtOS 工作台状态自检（占位，票 01）",
    handler: async (args, ctx) => {
      ctx.ui.notify(`cortxtos package loaded v0.1.0${args ? ` args=${args}` : ""} —— kb-search 见票 03，工具窄门见票 04`, "info");
    },
  });
}
