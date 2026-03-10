from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class OrderAttributeDefinition(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=120)
    input_type: Literal["string", "select", "boolean"] = "string"
    options: List[str] = Field(default_factory=list)
    required: bool = False


class ItemBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    item_type: Literal["essen", "getränk"] = "essen"
    description_html: Optional[str] = Field(default=None, max_length=40000)
    order_attributes: List[OrderAttributeDefinition] = Field(default_factory=list)
    price_eur: Optional[float] = Field(default=None, ge=0)
    quantity: Optional[float] = None
    unit: Optional[str] = None
    ean: Optional[str] = None


class ItemCreate(ItemBase):
    metadata_source: Optional[str] = None


class ItemUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    item_type: Optional[Literal["essen", "getränk"]] = None
    description_html: Optional[str] = Field(default=None, max_length=40000)
    order_attributes: Optional[List[OrderAttributeDefinition]] = None
    price_eur: Optional[float] = Field(default=None, ge=0)
    quantity: Optional[float] = None
    unit: Optional[str] = None
    ean: Optional[str] = None
    metadata_source: Optional[str] = None


class ItemOut(ItemBase):
    id: str
    created_at: datetime
    updated_at: datetime
    has_image: bool = False
    image_data_url: Optional[str] = None
    image_data_urls: List[str] = Field(default_factory=list)
    images: List[Dict[str, Any]] = Field(default_factory=list)


class StockIncreaseByEan(BaseModel):
    ean: str
    quantity_delta: float = Field(default=1, gt=0)


class StockAdjustRequest(BaseModel):
    item_id: Optional[str] = None
    ean: Optional[str] = None
    quantity_delta: float
    reason: Optional[Literal["consume", "restock", "inventory"]] = None


class ImageFromUrlRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
