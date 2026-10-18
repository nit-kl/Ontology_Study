"""名前空間、ファイルの場所、デモの日付。"""

from datetime import date
from pathlib import Path

from rdflib import Namespace, URIRef

ROOT = Path(__file__).resolve().parents[1]
LAYER1_DIR = ROOT / "data" / "layer1"
LAKE_DIR = ROOT / "data" / "lake"
KNOWLEDGE_DIR = ROOT / "knowledge"

TODAY = date(2026, 10, 23)      # UC1・UC3 の「今日」（金曜）
TOMORROW = date(2026, 10, 24)   # UC1 の発注の対象日（土曜）
DEMO_STORE = "ST-014"
STORE_NAMES = {"ST-014": "1号店", "ST-031": "2号店", "ST-040": "3号店", "DC-01": "東部DC"}


def store_name(site: str) -> str:
    return STORE_NAMES.get(site, site)


# シナリオごとの日付。UC2 は資料どおり、暑い夏の日にする
SCENARIOS = {
    "uc1": {"title": "UC1 明日の発注と需要予測", "day": TODAY},
    "uc2": {"title": "UC2 電力ピークの自動調整", "day": date(2026, 8, 7)},
    "uc3": {"title": "UC3 夕方の在庫融通と見切り", "day": TODAY},
}

EX = Namespace("urn:example:ns:")
SKU = Namespace("urn:example:sku:")
USKU = Namespace("urn:example:unified:")
STORE = Namespace("urn:example:store:")
EQUIP = Namespace("urn:example:equip:")
EVENT = Namespace("urn:example:event:")
CAT = Namespace("urn:example:cat:")
AREA = Namespace("urn:example:area:")
REC = Namespace("urn:example:rec:")
PLAN = Namespace("urn:example:plan:")
LINE = Namespace("urn:example:line:")
MODEL = Namespace("urn:example:model:")
PERSON = Namespace("urn:example:person:")
FC = Namespace("urn:example:forecast:")
AUDIT = Namespace("urn:example:audit:")
ZONE = Namespace("urn:example:zone:")
SENSOR = Namespace("urn:example:sensor:")
VEHICLE = Namespace("urn:example:vehicle:")
SETTING = Namespace("urn:example:setting:")
TRANSFER = Namespace("urn:example:transfer:")
BRICK = Namespace("https://brickschema.org/schema/Brick#")
GEO = Namespace("http://www.opengis.net/ont/geosparql#")
GEOF = Namespace("http://www.opengis.net/def/function/geosparql/")
UOM = Namespace("http://www.opengis.net/def/uom/OGC/1.0/")
ODRL = Namespace("http://www.w3.org/ns/odrl/2/")
PROV = Namespace("http://www.w3.org/ns/prov#")

# レイヤー3 のストアの Named Graph
G_ONTOLOGY = URIRef("urn:example:graph:ontology")
G_MASTER = URIRef("urn:example:graph:master")    # 商品・拠点・棚割・イベント
G_STATE = URIRef("urn:example:graph:state")      # 最新の状態（推奨数・予報・モデルの版）
G_PLANS = URIRef("urn:example:graph:plans")      # 合格した更新（発注計画）
G_POLICY = URIRef("urn:example:graph:policy")    # ODRL の権限
G_CDC = URIRef("urn:example:graph:cdc")          # 書き戻し後に CDC で戻ってきた SAP の発注

PREFIXES = f"""
PREFIX ex:   <{EX}>
PREFIX sku:  <{SKU}>
PREFIX store: <{STORE}>
PREFIX cat:  <{CAT}>
PREFIX event: <{EVENT}>
PREFIX plan: <{PLAN}>
PREFIX line: <{LINE}>
PREFIX model: <{MODEL}>
PREFIX person: <{PERSON}>
PREFIX equip: <{EQUIP}>
PREFIX zone: <{ZONE}>
PREFIX sensor: <{SENSOR}>
PREFIX vehicle: <{VEHICLE}>
PREFIX setting: <{SETTING}>
PREFIX transfer: <{TRANSFER}>
PREFIX geo:  <{GEO}>
PREFIX geof: <{GEOF}>
PREFIX uom:  <{UOM}>
PREFIX odrl: <{ODRL}>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
"""


def local(iri) -> str:
    """IRI の末尾の ID（urn:example:sku:R-9020 → R-9020）。"""
    s = str(iri)
    return s.rsplit(":", 1)[-1].rsplit("#", 1)[-1]
