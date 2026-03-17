// ============================================================
// CONFIG.JS — Gorilla Rental AI
// Central config: all keys, brand, equipment catalog, pricing
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY,
  STRIPE_KEY:    process.env.STRIPE_KEY,

  BOOQABLE: {
    API_KEY:  process.env.BOOQABLE_API_KEY,
    SUBDOMAIN: 'gorilla-rentals',
    BASE_URL:  'https://gorilla-rentals.booqable.com/api/1',
  },

  AZURE: {
    TENANT_ID:     process.env.TENANT_ID,
    CLIENT_ID:     process.env.CLIENT_ID,
    CLIENT_SECRET: process.env.CLIENT_SECRET,
  },

  CHIP: {
    EMAIL:    process.env.CHIP_EMAIL,
    PASSWORD: process.env.CHIP_PASSWORD,
  },

  GHL: {
    API_KEY:     process.env.GHL_API_KEY,
    LOCATION_ID: process.env.GHL_LOCATION_ID,
  },

  BRAND: {
    NAME:    'Gorilla Rental',
    PHONE:   '+14474744549',
    EMAIL:   'info@gorillarental.us',
    WEBSITE: 'gorillarental.us',
    LOGO:    'https://gorillarental.us/wp-content/uploads/2025/12/Untitled-design-2.png',
    YELLOW:  '#f6ec0e',
    LOCATION: 'South Florida (Fort Lauderdale, FL)',
  },
};

export const PRICING = {
  TAX_RATE:     0.07,
  DELIVERY_FEE: 200,
  DEPOSIT:      150,
};

export const DRIVERS = [
  { id: 'DRV-001', name: 'Andrei', phone: '+14474744549', email: 'info@gorillarental.us' },
  { id: 'DRV-002', name: 'Nazar',  phone: '+17860000000', email: '' },
];

export const EQUIPMENT_CATALOG = [
  { sku: 'BL001', name: 'Boom Lift 45ft',  type: 'boom_lift',    daily: 370,  weekly: 1200, monthly: 3700 },
  { sku: 'BL002', name: 'Boom Lift 65ft',  type: 'boom_lift',    daily: 400,  weekly: 1300, monthly: 4000 },
  { sku: 'BL003', name: 'Boom Lift 60ft',  type: 'boom_lift',    daily: 430,  weekly: 1400, monthly: 4300 },
  { sku: 'BL007', name: 'Boom Lift 125ft', type: 'boom_lift',    daily: 600,  weekly: 2000, monthly: 6000 },
  { sku: 'BL010', name: 'Boom Lift 85ft',  type: 'boom_lift',    daily: 450,  weekly: 1500, monthly: 4500 },
  { sku: 'BL011', name: 'Genie S-40 Boom', type: 'boom_lift',    daily: 150,  weekly: 490,  monthly: 1500 },
  { sku: 'SL001', name: 'Scissor Lift 32ft', type: 'scissor_lift', daily: 150, weekly: 500, monthly: 1500 },
  { sku: 'PS001', name: 'Shore Posts',     type: 'shore_post',   daily: null, weekly: null, monthly: 12   },
  { sku: 'SC001', name: 'Scaffolding',     type: 'scaffolding',  daily: 17,   weekly: null, monthly: null },
  { sku: 'OP001', name: 'Overhead Protection', type: 'overhead', daily: null, weekly: null, monthly: 20   },
];
