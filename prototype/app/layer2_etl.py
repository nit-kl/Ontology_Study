"""レイヤー2 セマンティックETL（Morph-KGC と RML の代わり）。

RML と同じ考え方で、「1行をどの主語にするか」「どの列をどの述語にするか」を MAPPINGS に宣言し、
小さな実行係がそれを読んで三つ組を作る。行き先の Named Graph もマッピングごとに決める。
本物の構成では、この表が RML のマッピング文書になり、Morph-KGC が実行する。
"""

from __future__ import annotations

import string
from dataclasses import dataclass
from datetime import date
from typing import Callable

from rdflib import RDF, RDFS, Literal, URIRef
from rdflib.namespace import XSD

from . import config as C
from .config import EX, GEO

Row = dict


@dataclass
class Col:
    """列の値を、その型のリテラルにする。空なら作らない。"""
    name: str
    datatype: URIRef = XSD.string

    def value(self, row: Row):
        v = row.get(self.name, "")
        return None if v in ("", None) else Literal(v, datatype=self.datatype)


@dataclass
class Iri:
    """列の値を埋めたテンプレートを IRI にする（RML の rr:template）。"""
    template: str

    def value(self, row: Row):
        fields = [f for _, f, _, _ in string.Formatter().parse(self.template) if f]
        if any(not row.get(f) for f in fields):
            return None
        return URIRef(self.template.format(**row))


@dataclass
class Fn:
    """行から値を計算する（RML の FnO 関数に相当）。"""
    fn: Callable[[Row], object]

    def value(self, row: Row):
        return self.fn(row)


@dataclass
class Mapping:
    name: str
    rows: Callable[["object"], list[Row]]   # レイヤー1 のどこから読むか
    graph: URIRef
    subject: str
    cls: URIRef | Callable[[Row], URIRef]
    po: list[tuple[URIRef, object]]


def _wkt(row: Row) -> Literal:
    return Literal(f"POINT({row['lon']} {row['lat']})", datatype=GEO.wktLiteral)


def _has_history(row: Row) -> Literal:
    launch = row.get("launch_date")
    return Literal(not launch or date.fromisoformat(launch) < C.TODAY)


def _adjustable(row: Row) -> list:
    kinds = []
    if "auto_min" in row and row["type"] == "AirHandlingUnit":
        kinds.append(EX.Setpoint)
    if row["type"] == "FreezerCase":
        kinds.append(EX.Precool)
    if row.get("auto_max_dim"):
        kinds.append(EX.Dimming)
    if row.get("defrost"):
        kinds.append(EX.DefrostShift)
    return kinds


def _num(key: str, dt=XSD.decimal):
    return Fn(lambda r: Literal(r[key], datatype=dt) if r.get(key) not in (None, "") else None)


def _equipment_rows(l1) -> list[Row]:
    rows = [dict(e, store=l1.bms.cfg["store"]) for e in l1.bms.cfg["equipment"]]
    m = l1.bms.cfg["meter"]
    rows.append({"id": m["id"], "type": "ElectricMeter", "name": "電力メーター（受電点）", "store": l1.bms.cfg["store"],
                 "contract_kw": m["contract_kw"]})
    return rows


def _route_wkt(row: Row) -> Literal:
    return Literal("LINESTRING(" + ", ".join(f"{x} {y}" for x, y in row["route"]) + ")", datatype=GEO.wktLiteral)


MAPPINGS: list[Mapping] = [
    Mapping("SAP 商品マスタ（小売側コード）", lambda l1: l1.sap.products, C.G_MASTER,
            str(C.SKU) + "{retail_code}", EX.Product, [
                (EX.code, Col("retail_code")),
                (RDFS.label, Col("name")),
                (EX.category, Iri(str(C.CAT) + "{category}")),
                (EX.tempZone, Iri(str(EX) + "{temp_zone}")),
                (EX.price, Col("price", XSD.integer)),
                (EX.caseSize, Col("case_size", XSD.integer)),
                (EX.shelfLifeDays, Col("shelf_life_days", XSD.integer)),
                (EX.gtin, Col("gtin")),
                (EX.launchDate, Col("launch_date", XSD.date)),
                (EX.hasSalesHistory, Fn(_has_history)),
                (EX.unifiedSku, Iri(str(C.USKU) + "U-{gtin}")),
            ]),
    Mapping("SAP 商品マスタ（卸側コード）", lambda l1: l1.sap.products, C.G_MASTER,
            str(C.SKU) + "{wholesale_code}", EX.Product, [
                (EX.code, Col("wholesale_code")),
                (RDFS.label, Col("name")),
                (EX.gtin, Col("gtin")),
                (EX.wholesale, Fn(lambda r: Literal(True))),
                (EX.unifiedSku, Iri(str(C.USKU) + "U-{gtin}")),
            ]),
    Mapping("SAP 拠点マスタ", lambda l1: l1.sap.sites, C.G_MASTER,
            str(C.STORE) + "{site_id}", lambda r: EX[r["kind"]], [
                (RDFS.label, Col("name")),
                (EX.closeTime, Col("close")),
                (EX.closeHour, Fn(lambda r: Literal(int(r["close"][:2]), datatype=XSD.integer) if r.get("close") else None)),
                (EX.area, Iri(str(C.AREA) + "{area}")),
                (EX.suppliedBy, Iri(str(C.STORE) + "{supplied_by}")),
                (GEO.hasGeometry, Iri(str(C.STORE) + "{site_id}-geom")),
            ]),
    Mapping("SAP 拠点の位置（GeoSPARQL）", lambda l1: l1.sap.sites, C.G_MASTER,
            str(C.STORE) + "{site_id}-geom", GEO.Geometry, [
                (GEO.asWKT, Fn(_wkt)),
            ]),
    Mapping("棚割", lambda l1: l1.pos.planogram, C.G_MASTER,
            str(C.EQUIP) + "{equipment}/{product}", EX.PlanogramSlot, [
                (EX.store, Iri(str(C.STORE) + "{store}")),
                (EX.product, Iri(str(C.SKU) + "{product}")),
                (EX.equipment, Iri(str(C.EQUIP) + "{equipment}")),
                (EX.capacity, Col("capacity", XSD.integer)),
            ]),
    Mapping("地域のイベント情報", lambda l1: l1.external.events, C.G_MASTER,
            str(C.EVENT) + "{id}", EX.Event, [
                (RDFS.label, Col("name")),
                (EX.eventType, Iri(str(EX) + "{type}")),
                (EX.start, Col("start", XSD.dateTime)),
                (EX.date, Fn(lambda r: Literal(r["start"][:10], datatype=XSD.date))),
                (EX.attendance, Col("attendance", XSD.integer)),
                (GEO.hasGeometry, Iri(str(C.EVENT) + "{id}-geom")),
            ]),
    Mapping("地域のイベント情報の位置（GeoSPARQL）", lambda l1: l1.external.events, C.G_MASTER,
            str(C.EVENT) + "{id}-geom", GEO.Geometry, [
                (GEO.asWKT, Fn(_wkt)),
            ]),
    Mapping("SAP 自動補充の推奨数（CDC）", lambda l1: l1.sap.replenishment, C.G_STATE,
            str(C.REC) + "{store}/{product}/{date}", EX.Recommendation, [
                (EX.store, Iri(str(C.STORE) + "{store}")),
                (EX.product, Iri(str(C.SKU) + "{product}")),
                (EX.date, Col("date", XSD.date)),
                (EX.quantity, Col("recommended", XSD.integer)),
            ]),
    Mapping("CMMS 設備台帳（Brick の種類）", _equipment_rows, C.G_MASTER,
            str(C.EQUIP) + "{id}", lambda r: EX[r["type"]], [
                (RDFS.label, Col("name")),
                (EX.inStore, Iri(str(C.STORE) + "{store}")),
                (EX.feeds, Iri(str(C.ZONE) + "{feeds}")),
                (EX.zone, Iri(str(C.ZONE) + "{zone}")),
                (EX.tempZone, Iri(str(EX) + "{temp_zone}")),
                (EX.ratedKw, _num("kw")),
                (EX.kwPerDegree, _num("kw_per_degree")),
                (EX.precoolKw, _num("precool_kw")),
                (EX.defrostKw, _num("defrost_kw")),
                (EX.contractKw, _num("contract_kw")),
                (EX.autoMin, _num("auto_min")),
                (EX.autoMax, _num("auto_max")),
                (EX.autoMaxDim, _num("auto_max_dim")),
                (EX.autoMinOutput, _num("auto_min_output")),
                (EX.adjustableBy, Fn(_adjustable)),
            ]),
    Mapping("BMS 運転状態（設定温度・霜取りの予定）", lambda l1: l1.bms.cfg["equipment"], C.G_STATE,
            str(C.EQUIP) + "{id}", EX.Equipment, [
                (EX.setpoint, _num("setpoint")),
                (EX.defrostAt, Fn(lambda r: [Literal(h, datatype=XSD.decimal) for h in r.get("defrost", [])])),
            ]),
    Mapping("CMMS 区画", lambda l1: l1.bms.cfg["zones"], C.G_MASTER,
            str(C.ZONE) + "{id}", EX.Zone, [
                (RDFS.label, Col("name")),
                (EX.window, Fn(lambda r: Literal(bool(r.get("window"))))),
            ]),
    Mapping("CMMS センサー台帳（SSN/SOSA のセンサー）", lambda l1: l1.bms.cfg["sensors"], C.G_MASTER,
            str(C.SENSOR) + "{id}",
            lambda r: {"zone": EX.ZoneTemperatureSensor, "case": EX.CaseTemperatureSensor,
                       "outdoor": EX.OutdoorTemperatureSensor}[r["kind"]], [
                (EX.locatedIn, Iri(str(C.ZONE) + "{located_in}")),
                (EX.attachedTo, Iri(str(C.EQUIP) + "{attached_to}")),
            ]),
    Mapping("TMS 配送車の台帳と今夜のルート（GeoSPARQL の線）", lambda l1: l1.tms.vehicles, C.G_MASTER,
            str(C.VEHICLE) + "{id}", EX.Vehicle, [
                (RDFS.label, Col("name")),
                (EX.home, Iri(str(C.STORE) + "{home}")),
                (EX.tempZone, Iri(str(EX) + "{temp_zone}")),
                (EX.coldHours, _num("cold_hours")),
                (EX.freeUnits, _num("free_units", XSD.integer)),
                (EX.transitMinutes, _num("transit_minutes", XSD.integer)),
                (EX.etaReceiving, Col("eta_receiving")),
                (EX.routeLabel, Col("route_label")),
                (GEO.hasGeometry, Iri(str(C.VEHICLE) + "{id}-route")),
            ]),
    Mapping("TMS ルートの線", lambda l1: l1.tms.vehicles, C.G_MASTER,
            str(C.VEHICLE) + "{id}-route", GEO.Geometry, [
                (GEO.asWKT, Fn(_route_wkt)),
            ]),
    Mapping("気象局の予報", lambda l1: l1.external.weather, C.G_STATE,
            str(C.FC) + "{area}/{date}", EX.WeatherForecast, [
                (EX.area, Iri(str(C.AREA) + "{area}")),
                (EX.date, Col("date", XSD.date)),
                (EX.maxCelsius, Col("max_celsius", XSD.integer)),
            ]),
]


def run_mapping(m: Mapping, rows: list[Row]):
    """1行から三つ組を複数つくる（Morph-KGC の役）。値が並びなら、値ごとに1つずつ作る。"""
    for row in rows:
        s = URIRef(m.subject.format(**row))
        yield s, RDF.type, (m.cls(row) if callable(m.cls) else m.cls)
        for p, spec in m.po:
            o = spec.value(row)
            for v in (o if isinstance(o, list) else [o]):
                if v is not None:
                    yield s, p, v


def load_all(layer1, kg) -> list[dict]:
    """全マッピングを実行して、レイヤー3 のストアへ入れる。何をいくつ入れたかを返す。"""
    report = []
    for m in MAPPINGS:
        rows = m.rows(layer1)
        triples = list(run_mapping(m, rows))
        kg.add_triples(m.graph, triples)
        report.append({"mapping": m.name, "rows": len(rows), "triples": len(triples),
                       "graph": str(m.graph)})
    return report


def sync_cdc(layer1, kg) -> list[dict]:
    """SAP の変更（書き戻しの結果）を CDC で読み、ストアの CDC の Named Graph を差し替える。"""
    pending, layer1.sap.changes = layer1.sap.changes, []
    for ch in pending:
        for product, qty in ch["lines"].items():
            s = URIRef(f"urn:example:sto:{ch['sto']}/{product}")
            kg.replace_value(C.G_CDC, s, EX.quantity, Literal(qty, datatype=XSD.integer),
                             extra=[(RDF.type, EX.SapOrderLine),
                                    (EX.product, C.SKU[product]),
                                    (EX.sto, Literal(ch["sto"]))])
    return pending


def stream_readings(kg, store: str, time: str, readings: dict, lake: list) -> None:
    """センサーと電力メーターの計測値（ストリーム）。最新の1件をストアで差し替え、全件を履歴の蓄積先へ追記する。"""
    for sensor, value in readings.items():
        if sensor in ("time", "kw"):
            continue
        s = C.SENSOR[sensor]
        kg.replace_value(C.G_STATE, s, EX.latestValue, Literal(value, datatype=XSD.decimal),
                         extra=[(EX.latestTime, Literal(time))])
    kg.replace_value(C.G_STATE, C.EQUIP["EM-014"], EX.latestDemandKw, Literal(readings["kw"], datatype=XSD.decimal),
                     extra=[(EX.latestTime, Literal(time))])
    lake.append({"time": time, "store": store, **readings})
