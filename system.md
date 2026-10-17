# CP Axtra 構成と欠品代替

[usecase.md](usecase.md) の欠品代替は、次の経路でこの構成を通る。店頭在庫の確認と引当はネットスーパー（My Lotus's）が POS に対して行い、ナレッジグラフは代替の判断と点検を受け持つ。

層ごとの説明: [レイヤー1 基幹システム](docs/layer-1.md)、[レイヤー2 セマンティックETL](docs/layer-2.md)、[レイヤー3 ナレッジグラフ](docs/layer-3.md)、[レイヤー4 AI推論とキネティック実行](docs/layer-4.md)、[レイヤー5 業務画面とガバナンス](docs/layer-5.md)。

- シーン1: My Lotus's が POS の店頭在庫を確認する。欠品なら AI（Bedrock 上の LangGraph エージェント）に代替を頼み、AI が SPARQL で問い合わせ、OWL が同じ容量・同じ区分の牛乳を推論する。候補の在庫も My Lotus's が POS で確認する
- シーン2: AI がレイヤー3の欠品代替の方針（支払額は元のまま、差額は店舗負担）で提案を作り、SHACL が事前検証する（乳成分の一致、支払額上限、値引上限）。合格したら業務画面が承認カードを出す。1タップ承認は承認付きのアクション要求になり、SHACL が承認の有無を加えて再検証する。合格すると SPARQL Update で注文の対象商品を差し替え、Update の成功を受けて PROV-O の来歴が監査グラフに残る
- シーン3: KINETIC が POS（ピッカー端末と引当）、SAP（引当と会計伝票）、My Lotus's（注文の原本）の順に書き戻す。POS で引当できなければ、残りを止めて注文を元に戻し、取り消しの来歴を残してお客さんに伝える。ピッキング完了と配達出発は、レイヤー1の中で My Lotus's に表示される
- データの置き場: 商品マスタ、顧客、注文と、ロットの最新状態、センサーごとの最新の温度、今の売価はトリプルストアに入る。販売明細、温度の連続記録、在庫移動や発注の履歴、注文の変更履歴は履歴の蓄積先に入る。承認と取り消しの来歴はレイヤー5の監査グラフに入る

```mermaid
flowchart TB
    subgraph L5["Layer 5: 業務画面 & ガバナンス層 (Workshop / Lineage 代替)"]
        UI1["モデル駆動型Webアプリ<br/>(Metaphactory / React)<br/>【SHACL Form / GraphQL-LD】<br/>シーン2: 承認カードと1タップ承認"]
        UI2["サプライチェーン・コントロールタワー<br/>【GeoSPARQL / BI】"]
        GOV["データ来歴・監査・権限基盤<br/>【W3C PROV-O / ODRL / Named Graph】<br/>シーン2: 承認の来歴（監査グラフ）"]
    end

    subgraph L4["Layer 4: AI推論 & キネティック実行層 (AIP / Actions 代替)"]
        AI["GraphRAG & AIエージェント<br/>(Amazon Bedrock + LangGraph / MCP)<br/>自然言語 ➔ SPARQL生成<br/>シーン1・2: 代替の探索と提案"]
        SPARQL["フェデレーション・クエリ基盤<br/>【W3C SPARQL 1.1 Query / Update】<br/>シーン1: 代替の照会 / シーン2: 注文の更新"]
        KINETIC["Kinetic ワークフローエンジン<br/>(Temporal / Camunda)<br/>【CloudEvents / BPMN 2.0】<br/>シーン3: ピッカー・在庫・会計・注文へ反映"]
    end

    subgraph L3["Layer 3: W3C ナレッジグラフ・コア層 (Foundry Ontology 代替)"]
        OWL["CP Axtra ドメインオントロジー & 推論<br/>(UnifiedSKU / Store / Batch)<br/>【W3C OWL 2 / SKOS / GS1】<br/>シーン1: 同じ容量・区分の代替を推論"]
        RDF["マルチモデル RDFトリプルストア<br/>(GraphDB / Stardog / Neptune)<br/>【W3C RDF 1.2 / RDF-star / URI】<br/>マスタ・注文・最新状態"]
        SHACL["形状制約 & アクション検証エンジン<br/>(乳成分・支払額・値引上限・在庫移動・承認)<br/>【W3C SHACL】<br/>シーン2: 事前検証と承認時の再検証"]
    end

    subgraph L2["Layer 2: セマンティックETL層 (HyperAuto 代替)"]
        RML["セマンティックETL & ストリーミング<br/>(Morph-KGC / Kafka)<br/>【W3C RML / CSVW / SSN・SOSA】"]
        LAKE[("履歴の蓄積先<br/>(データレイク)<br/>販売明細・温度の連続記録・在庫移動履歴・注文の変更履歴")]
    end

    subgraph L1["Layer 1: CP Axtra 基幹システム層 (Makro 卸売 & Lotus's 小売)"]
        SAP[("SAP S/4HANA & Ariba<br/>(商品・発注PO・在庫移動STO・会計)<br/>シーン3: 引当と差額の会計伝票")]
        POS[("店舗 POS & 電子棚札 & ピッカー端末<br/>(店頭在庫・販売実績・ダイナミック売価)<br/>シーン1: 店頭在庫 / シーン3: 引当・ピッキング")]
        WMS[("WMS / TMS & 温度IoT<br/>(DCロット在庫・コールドチェーン・配送)")]
        CRM[("Makro PRO / My Lotus's<br/>(HoReCa法人顧客・ネットスーパーと注文の原本)<br/>シーン1〜3: 注文・承認カード・配達表示")]
    end

    %% データ統合・クエリフロー
    SAP & POS & WMS & CRM -->|"バッチ/CDC"| RML
    RML -->|"マスタ・注文・最新状態のRDFトリプル"| RDF
    RML -->|"履歴"| LAKE
    LAKE -->|"集計"| UI2
    OWL <-->|"シーン1: 論理推論・分類"| RDF
    RDF <-->|"Query / Update"| SPARQL
    SPARQL --> UI1 & UI2

    %% シーン1: 在庫確認と代替の照会
    CRM -->|"シーン1: 1. 店頭在庫の確認 (API)"| POS
    CRM -->|"シーン1・2: 2. 代替の依頼"| AI
    AI <-->|"シーン1: 3. SPARQL Query"| SPARQL
    AI -->|"シーン1: 4. 代替候補"| CRM

    %% シーン2: 事前検証・承認・再検証
    AI ==>|"シーン2: 5. 事前検証"| SHACL
    SHACL ==>|"シーン2: 6. 事前検証の結果"| AI
    AI ==>|"シーン2: 7. 承認カードの依頼"| UI1
    UI1 ==>|"シーン2: 8. 承認カード"| CRM
    CRM ==>|"シーン2: 9. 1タップ承認"| UI1
    UI1 ==>|"シーン2: 10. 承認付きアクション要求"| SHACL
    SHACL ==>|"シーン2: 11. 再検証OK ➔ SPARQL Update"| SPARQL
    SPARQL ==>|"シーン2: 12. Update 成功"| SHACL
    SHACL ==>|"シーン2: 13. 監査証跡記録"| GOV

    %% シーン3: Write-back
    SHACL ==>|"シーン3: 14. イベント発火"| KINETIC
    KINETIC ==>|"シーン3: 15. Write-back (BAPI / Webhook)"| SAP & POS & CRM
    KINETIC -.->|"引当失敗時: 注文を元に戻す Update"| SPARQL
    KINETIC -.->|"引当失敗時: 取り消しの来歴"| GOV
    KINETIC -.->|"在庫移動 (STO) など別のアクション"| WMS

    classDef w3c fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#0f172a;
    classDef gate fill:#eff6ff,stroke:#e11d48,stroke-width:2px,color:#0f172a;
    classDef kinetic fill:#fff1f2,stroke:#e11d48,stroke-width:2px,color:#881337;
    classDef source fill:#f1f5f9,stroke:#64748b,stroke-width:1.5px,color:#1e293b;
    class UI1,UI2,GOV,AI,SPARQL,OWL,RDF,RML w3c;
    class SHACL gate;
    class KINETIC kinetic;
    class SAP,POS,WMS,CRM,LAKE source;
```
