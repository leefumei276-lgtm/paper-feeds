# paper-feeds

按摘要把数据经济、平台经济、供应链、人工智能主题的论文分成三个 RSS 订阅，每天自动更新。

- `docs/A-game-theory.xml`：主题相关，且用了博弈论。标 [疑似] 的是摘要未明说、但看起来是理论模型的论文。
- `docs/B-related-non-game.xml`：主题相关，但摘要中未见博弈论方法。
- `docs/C-pending.xml`：标题主题相关，但暂无摘要。摘要入库后会移到 A 或 B。
- `docs/T5-game-theory.xml`：经济学 Top 5（AER、Econometrica、JPE、QJE、RES）中用了博弈论的论文，不限主题。
- `docs/T5-other.xml`：Top 5 的其余论文。标 [待判定] 的是暂无摘要的论文。

分类由 `build.js` 中的关键词规则完成，会有误判和漏判。摘要只保留前 300 字，全文请看原文链接。
