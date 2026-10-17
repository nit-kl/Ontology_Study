# 欠品代替のユースケース

ネットスーパーで注文した牛乳が店頭で売り切れたとき、代替品を探し、お客さんの承認を得て、現場のシステムへ書き戻すまでの流れです。各参加者がどの層にあたるかは [構成図](system.md) を参照してください。

```mermaid
sequenceDiagram
    autonumber
    actor Customer as ① お客さんのスマホ<br/>(My Lotus's ネットスーパー)
    participant Store as ② 店舗・基幹システム<br/>(POS・ピッカー端末 / SAP / EC注文)
    participant AI as ③ AI 提案<br/>(Bedrock + LangGraph / MCP)
    participant KG as ④ 商品ナレッジグラフ & ルール番人<br/>(W3C OWL / RDF / SHACL)
    participant UI as ⑤ 承認画面 & 来歴<br/>(SHACL Form / W3C PROV-O)
    participant Kin as ⑥ 現場手配ディレクター<br/>(Temporal)

    rect rgb(240, 249, 255)
    Note over Customer,Kin: シーン1：注文した牛乳が店頭で売り切れた！（欠品検知と代替品探し）
    Customer->>Store: 「A社 おいしい牛乳 1L (80バーツ)」を注文し、店頭在庫を確認 [POS 在庫 API]
    Store-->>Customer: 応答：「店頭で最後の1本が売れて在庫ゼロ（欠品）！」
    Customer->>AI: 欠品したA社牛乳の代替を依頼
    AI->>KG: 「A社と同じ容量・同じ区分」の代替を問い合わせ [SPARQL Query]
    Note over KG: 【W3C OWL 推論】ベテラン店員の知識で検索<br/>・A社と同じ「1L・無調整」の牛乳を探索<br/>➔『B社 オーガニック牛乳 (通常95B)』を発見！
    KG-->>AI: 代替候補『B社 オーガニック牛乳』
    AI-->>Customer: 代替候補『B社 オーガニック牛乳』
    Customer->>Store: B社牛乳の店頭在庫を確認 [POS 在庫 API]
    Store-->>Customer: 在庫あり
    end

    rect rgb(238, 242, 255)
    Note over Customer,Kin: シーン2：お客さんへ提案する前の「ルールチェック」と1タップ承認
    Customer->>AI: 「B社は在庫あり」。代替の提案を依頼
    Note over AI: 欠品代替の方針（お値段そのまま・差額は店舗負担）を<br/>ナレッジグラフから読み、提案を作成
    AI->>KG: 代替案（B社オーガニック牛乳を80Bのまま提供）の事前検証を依頼
    Note over KG: 【W3C SHACL 事前検証】ミス防止チェック（まだ何も書き換えない）<br/>✔ アレルギー成分（乳）は同じか？ ➔ OK<br/>✔ 支払額（80B）は承諾済みの額を超えていないか？ ➔ OK<br/>✔ 店舗負担の差額15Bは値引上限（通常価格の20% = 19B）以内か？ ➔ OK
    KG-->>AI: 事前検証 合格
    AI->>UI: 承認カードの作成を依頼
    UI-->>Customer: スマホ通知：「品切れのため、お値段そのまま(80B)で<br/>『B社オーガニック牛乳』に変更してよいですか？」
    Customer->>UI: 14:22 スマホで「変更を承認する」を1タップ！
    UI->>KG: 承認付きのアクション要求
    Note over KG: 【W3C SHACL 再検証】事前検証と同じ点検 ＋ お客さん自身の承認があるか ➔ OK<br/>➔ 注文の対象商品をB社牛乳へ差し替え [SPARQL Update] ➔ 成功
    KG->>UI: 監査イベント
    Note over UI: 「14:22にお客さん自身が承認」を監査グラフに記録 [W3C PROV-O]
    end

    rect rgb(255, 241, 242)
    Note over Customer,Kin: シーン3：現場の端末・在庫・会計・注文を自動で一斉書き換え (Write-back)
    KG->>Kin: 変更確定イベント発火 [CloudEvents] ➔ 現場手配ディレクター(Temporal)が起動
    Kin->>Store: 【Write-back】BAPI / Webhook（POS ➔ SAP ➔ My Lotus's の順）
    Note over Store: ① 売場スタッフのピッキング端末を「B牛乳」へ書き換え (POS)<br/>② POS/SAPの在庫からB牛乳を1本引き当て<br/>③ 差額15バーツを店舗負担として会計伝票を自動修正 (SAP)<br/>④ ネットスーパーの注文原本をB牛乳へ更新 (My Lotus's)
    Note over Kin,Store: ※ 承認のあいだにB牛乳が売れてPOSで引き当てられなかったら、<br/>残りの書き戻しを止め、注文をA社に戻し [SPARQL Update]、<br/>取り消しを来歴に残して、お客さんに「代替できませんでした」と通知
    Note over Store: 売場スタッフがピッキングを完了 ➔ 配送 (TMS) が出発
    Store-->>Customer: アプリ表示：「代替品のピッキングが完了し、配達に出発しました！」
    end
```
