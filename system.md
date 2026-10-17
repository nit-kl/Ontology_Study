# 小売グループの構成とユースケース

[ユースケース](usecase.md) の3つの場面は、どれもこの構成を同じ型で通る。きっかけを受け、AI がナレッジグラフで調べ、SHACL が事前検証し、必要なときだけ決められた人が承認し、SHACL の再検証と SPARQL Update で確定し、KINETIC が基幹システムと店舗設備へ書き戻す。店頭在庫と今日の販売数はいつも POS が答え、ナレッジグラフは判断と点検と記録を受け持つ。

層ごとの説明: [レイヤー1 基幹システム](docs/layer-1.md)、[レイヤー2 セマンティックETL](docs/layer-2.md)、[レイヤー3 ナレッジグラフ](docs/layer-3.md)、[レイヤー4 AI推論とキネティック実行](docs/layer-4.md)、[レイヤー5 業務画面とガバナンス](docs/layer-5.md)。

## ユースケースごとの経路

- [UC1 ネットスーパーの欠品代替](usecases/uc1-stockout.md): ネットスーパーアプリが POS の店頭在庫を確認し、欠品なら AI に代替を頼む。OWL が同じ容量・同じ区分の牛乳を推論し、AI が欠品代替の方針で提案を作る。SHACL の事前検証、お客さんの1タップ承認、再検証を経て注文を差し替え、KINETIC が POS、SAP、ネットスーパーアプリの順に書き戻す。POS で引当できなければ取り消す
- [UC2 電力ピークの自動調整](usecases/uc2-power-peak.md): 毎日 12:30 に KINETIC のスケジュールが AI に調整案を頼む。OWL が予報、電力メーター、設備台帳から、ピークの見込みと動かせる設備を推論する。SHACL が食品安全、霜取りの間隔、売場の快適性、設備操作の範囲を点検し、方針の範囲内なので承認なしで確定する。KINETIC が BMS で霜取り、予冷、空調、照明を時刻どおりに動かし、実行中は SHACL で温度を見張る。外れたら AI がその設備だけを元に戻す
- [UC3 夕方の在庫融通と見切り](usecases/uc3-evening-transfer.md): 毎日 16:00 に KINETIC のスケジュールが AI に融通の案を頼む。AI が近くの3店の POS に店頭在庫と今日の販売数を聞き、GeoSPARQL で帰り便が立ち寄れる店を探す。上限以内の移動と見切りは承認なしで、上限を超える移動は受け入れる店の店長の承認で確定する。KINETIC が SAP、TMS、スタッフ端末、POS、電子棚札へ書き戻し、数が足りなければ数量を直し、見切りは時刻を待って値引きする
- データの置き場: 商品マスタ、店・設備・車両の台帳、棚割、顧客、注文と、ロット、設備、センサー、電力メーター、予報、売価、車両のルートの最新状態、確定した調整計画・店間移動・見切りはトリプルストアに入る。販売明細、温度と電力の連続記録、在庫移動や発注の履歴、注文の変更履歴は履歴の蓄積先に入る。承認、自動で確定した規則、取り消し、元に戻した操作の来歴はレイヤー5の監査グラフに入る

## 構成図

```mermaid
flowchart TB
    subgraph L5["Layer 5: 業務画面 & ガバナンス層 (Workshop / Lineage 代替)"]
        UI1["モデル駆動型Webアプリ<br/>(Metaphactory / React)<br/>【SHACL Form / GraphQL-LD】<br/>承認カードと承認画面・自動調整の通知<br/>UC1: お客さん / UC2・UC3: 店長"]
        UI2["サプライチェーン・コントロールタワー<br/>【GeoSPARQL / BI】<br/>店・設備・車両の地図と、電力・欠品・廃棄の指標"]
        GOV["データ来歴・監査・権限基盤<br/>【W3C PROV-O / ODRL / Named Graph】<br/>承認・自動確定・取り消し・戻しの来歴（監査グラフ）"]
    end

    subgraph L4["Layer 4: AI推論 & キネティック実行層 (AIP / Actions 代替)"]
        AI["GraphRAG & AIエージェント<br/>(Amazon Bedrock + LangGraph / MCP)<br/>自然言語 ➔ SPARQL生成<br/>代替・電力調整・在庫融通の提案"]
        SPARQL["フェデレーション・クエリ基盤<br/>【W3C SPARQL 1.1 Query / Update / GeoSPARQL】<br/>照会と確定した更新"]
        KINETIC["Kinetic ワークフローエンジン<br/>(Temporal / Camunda)<br/>【CloudEvents / BPMN 2.0】<br/>スケジュールで起動・時刻待ち・見張り・書き戻し・取り消し"]
    end

    subgraph L3["Layer 3: W3C ナレッジグラフ・コア層 (Foundry Ontology 代替)"]
        OWL["小売ドメインオントロジー & 推論<br/>(UnifiedSKU / Store / Batch / Equipment / 温度帯)<br/>【W3C OWL 2 / SKOS / GS1 / Brick / GeoSPARQL】<br/>代替・動かせる設備・立ち寄れる店を推論"]
        RDF["マルチモデル RDFトリプルストア<br/>(GraphDB / Stardog / Neptune)<br/>【W3C RDF 1.2 / RDF-star / URI】<br/>マスタ・台帳・注文・最新状態・確定した計画"]
        SHACL["形状制約 & アクション検証エンジン<br/>(食品安全・設備操作・在庫移動・値引き・承認など)<br/>【W3C SHACL】<br/>事前検証・承認時の再検証・実行中の見張り"]
    end

    subgraph L2["Layer 2: セマンティックETL層 (HyperAuto 代替)"]
        RML["セマンティックETL & ストリーミング<br/>(Morph-KGC / Kafka)<br/>【W3C RML / CSVW / SSN・SOSA / GeoSPARQL】"]
        LAKE[("履歴の蓄積先<br/>(データレイク)<br/>販売明細・温度と電力の連続記録・在庫移動履歴・注文の変更履歴")]
    end

    subgraph L1["Layer 1: 基幹システム層 (卸売 & 小売)"]
        SAP[("SAP S/4HANA & Ariba<br/>(商品・拠点・発注PO・在庫移動STO・会計)")]
        POS[("店舗システム<br/>(POS・電子棚札・棚割・スタッフ端末)<br/>店頭在庫・今日の販売数・売価・作業指示")]
        FAC[("店舗設備<br/>(BMS・空調・照明・冷蔵/冷凍ケース・電力メーター・センサー・CMMS)<br/>設備の状態と遠隔操作")]
        WMS[("WMS / TMS & 輸送の温度IoT<br/>(DCロット在庫・配車とルート・コールドチェーン)")]
        CRM[("法人向けサービス / ネットスーパーアプリ<br/>(HoReCa法人顧客・ネットスーパーと注文の原本)")]
        EXT[("外部データ<br/>(気象局の予報)")]
    end

    %% データ統合・クエリフロー
    SAP & POS & FAC & WMS & CRM & EXT -->|"バッチ/CDC/ストリーム"| RML
    RML -->|"マスタ・台帳・注文・最新状態のRDFトリプル"| RDF
    RML -->|"履歴"| LAKE
    LAKE -->|"集計"| UI2
    OWL <-->|"論理推論・分類"| RDF
    RDF <-->|"Query / Update"| SPARQL
    SPARQL --> UI1 & UI2
    GOV -->|"ODRL の権限"| RDF

    %% きっかけと調べる
    CRM -->|"UC1: 店頭在庫の確認 (API)"| POS
    CRM -->|"UC1: 代替の依頼"| AI
    KINETIC -->|"UC2・UC3: スケジュールで提案を依頼"| AI
    AI <-->|"SPARQL Query"| SPARQL
    AI -->|"UC3: 店頭在庫と販売数 (MCP)"| POS
    AI -->|"UC1: 代替候補"| CRM

    %% 事前検証・承認・再検証
    AI ==>|"事前検証・承認不要のアクション"| SHACL
    SHACL ==>|"事前検証の結果"| AI
    AI ==>|"承認カード・承認依頼・通知"| UI1
    UI1 ==>|"UC1: お客さんへの承認カード"| CRM
    CRM ==>|"UC1: お客さんの承認"| UI1
    UI1 ==>|"承認付きアクション要求"| SHACL
    SHACL ==>|"合格 ➔ SPARQL Update"| SPARQL
    SPARQL ==>|"Update 成功"| SHACL
    SHACL ==>|"監査証跡記録"| GOV

    %% Write-back と見張り
    SHACL ==>|"確定イベント"| KINETIC
    KINETIC ==>|"Write-back (BAPI / Webhook / BMS)"| SAP & POS & FAC & WMS & CRM
    POS & FAC & WMS -->|"結果・作業の完了・実数"| KINETIC
    KINETIC -.->|"UC2: 実行中の見張り"| SHACL
    KINETIC -.->|"失敗・違反時: 戻しや数量修正の依頼"| AI
    KINETIC -.->|"UC1 の失敗時: 取り消しの Update"| SPARQL
    KINETIC -.->|"UC1 の失敗時: 取り消しの来歴"| GOV

    classDef w3c fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#0f172a;
    classDef gate fill:#eff6ff,stroke:#e11d48,stroke-width:2px,color:#0f172a;
    classDef kinetic fill:#fff1f2,stroke:#e11d48,stroke-width:2px,color:#881337;
    classDef source fill:#f1f5f9,stroke:#64748b,stroke-width:1.5px,color:#1e293b;
    class UI1,UI2,GOV,AI,SPARQL,OWL,RDF,RML w3c;
    class SHACL gate;
    class KINETIC kinetic;
    class SAP,POS,FAC,WMS,CRM,EXT,LAKE source;
```

承認が要らないアクション（UC2 の方針の範囲内の調整と元に戻す操作、UC3 の上限以内の移動・見切り・数量の減少など）は、事前検証のあとに承認と再検証を飛ばして、そのまま Update と確定イベントへ進む。どのアクションに誰の承認が要るかは [レイヤー3](docs/layer-3.md#承認の要否) で決めている。
