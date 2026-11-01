/**
 * Database seeder — realistic Nigerian logistics test data.
 * Run with: bun run src/db/seed.ts
 *
 * Creates:
 *  - 2 businesses
 *  - 3 drivers (bike, car, van)
 *  - 4 customers
 *  - 10 shipments across all statuses
 *  - Shipment events for each shipment
 *  - Notifications for users
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { hashSync } from "bcryptjs";
import { nanoid } from "nanoid";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set. Copy .env.example → .env first.");
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const db = drizzle(sql, { schema });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const id = () => nanoid();
const passwordHash = hashSync("Password123!", 10);

function trackingId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = Array.from({ length: 8 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join("");
  return `IST-${rand}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ─── Seed data ────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log("🌱 Seeding IsoTrack database with Nigerian logistics data...\n");

  // ── 1. Users ──────────────────────────────────────────────────────────────

  console.log("  → Inserting users...");

  // Business owners
  const businessUser1Id = id();
  const businessUser2Id = id();

  // Drivers
  const driverUser1Id = id();
  const driverUser2Id = id();
  const driverUser3Id = id();

  // Customers
  const customerUser1Id = id();
  const customerUser2Id = id();
  const customerUser3Id = id();
  const customerUser4Id = id();

  await db.insert(schema.users).values([
    // Business accounts
    {
      id: businessUser1Id,
      email: "admin@jumialogistics.ng",
      passwordHash,
      name: "Emeka Okonkwo",
      role: "business",
      phone: "+2348012345678",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
    },
    {
      id: businessUser2Id,
      email: "ops@swiftcargo.ng",
      passwordHash,
      name: "Aisha Bello",
      role: "business",
      phone: "+2348087654321",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
    },

    // Driver accounts
    {
      id: driverUser1Id,
      email: "tunde.rider@isotrack.ng",
      passwordHash,
      name: "Babatunde Adeleke",
      role: "driver",
      phone: "+2348023456789",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(25),
      updatedAt: daysAgo(1),
    },
    {
      id: driverUser2Id,
      email: "chidi.driver@isotrack.ng",
      passwordHash,
      name: "Chidi Eze",
      role: "driver",
      phone: "+2348034567890",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(22),
      updatedAt: daysAgo(2),
    },
    {
      id: driverUser3Id,
      email: "fatima.driver@isotrack.ng",
      passwordHash,
      name: "Fatima Suleiman",
      role: "driver",
      phone: "+2348045678901",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(3),
    },

    // Customer accounts
    {
      id: customerUser1Id,
      email: "ngozi.customer@gmail.com",
      passwordHash,
      name: "Ngozi Adaeze",
      role: "customer",
      phone: "+2348056789012",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(15),
      updatedAt: daysAgo(15),
    },
    {
      id: customerUser2Id,
      email: "segun.ola@yahoo.com",
      passwordHash,
      name: "Segun Olawale",
      role: "customer",
      phone: "+2348067890123",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(12),
      updatedAt: daysAgo(12),
    },
    {
      id: customerUser3Id,
      email: "zainab.ibrahim@gmail.com",
      passwordHash,
      name: "Zainab Ibrahim",
      role: "customer",
      phone: "+2348078901234",
      isEmailVerified: true,
      isActive: true,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(10),
    },
    {
      id: customerUser4Id,
      email: "peter.obi@outlook.com",
      passwordHash,
      name: "Peter Obiechina",
      role: "customer",
      phone: "+2348089012345",
      isEmailVerified: false,
      isActive: true,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
  ]);

  // ── 2. Businesses ─────────────────────────────────────────────────────────

  console.log("  → Inserting businesses...");

  const business1Id = id();
  const business2Id = id();

  await db.insert(schema.businesses).values([
    {
      id: business1Id,
      userId: businessUser1Id,
      businessName: "Jumia Logistics NG",
      address: {
        street: "14 Admiralty Way",
        city: "Lekki",
        state: "Lagos",
        country: "Nigeria",
        postalCode: "106104",
        coordinates: { lat: 6.4281, lng: 3.4219 },
      },
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
    },
    {
      id: business2Id,
      userId: businessUser2Id,
      businessName: "SwiftCargo Nigeria",
      address: {
        street: "Plot 22, Ahmadu Bello Way",
        city: "Abuja",
        state: "FCT",
        country: "Nigeria",
        postalCode: "900001",
        coordinates: { lat: 9.0765, lng: 7.3986 },
      },
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
    },
  ]);

  // ── 3. Drivers ────────────────────────────────────────────────────────────

  console.log("  → Inserting drivers...");

  const driver1Id = id();
  const driver2Id = id();
  const driver3Id = id();

  await db.insert(schema.drivers).values([
    {
      id: driver1Id,
      userId: driverUser1Id,
      businessId: business1Id,
      vehicleType: "bike",
      vehiclePlate: "LND-421-GH",
      status: "available",
      currentLocation: { lat: 6.5244, lng: 3.3792 },
      rating: 4.8,
      totalDeliveries: 147,
      createdAt: daysAgo(25),
      updatedAt: daysAgo(1),
    },
    {
      id: driver2Id,
      userId: driverUser2Id,
      businessId: business1Id,
      vehicleType: "car",
      vehiclePlate: "ABC-789-FG",
      status: "on_delivery",
      currentLocation: { lat: 6.4698, lng: 3.5852 },
      rating: 4.6,
      totalDeliveries: 89,
      createdAt: daysAgo(22),
      updatedAt: daysAgo(0),
    },
    {
      id: driver3Id,
      userId: driverUser3Id,
      businessId: business2Id,
      vehicleType: "van",
      vehiclePlate: "KJA-554-CE",
      status: "offline",
      currentLocation: { lat: 9.0574, lng: 7.4898 },
      rating: 4.9,
      totalDeliveries: 203,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(3),
    },
  ]);

  // ── 4. Shipments ──────────────────────────────────────────────────────────

  console.log("  → Inserting shipments...");

  const shipmentIds = Array.from({ length: 10 }, () => id());
  const trackingIds = Array.from({ length: 10 }, () => trackingId());

  await db.insert(schema.shipments).values([
    // Delivered
    {
      id: shipmentIds[0]!,
      trackingId: trackingIds[0]!,
      status: "delivered",
      businessId: business1Id,
      driverId: driver1Id,
      customerId: customerUser1Id,
      description: "Electronics — Samsung Galaxy S24 Ultra",
      weightKg: 0.5,
      pickupAddress: {
        street: "14 Admiralty Way, Lekki Phase 1",
        city: "Lekki",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4281, lng: 3.4219 },
      },
      deliveryAddress: {
        street: "5 Bourdillon Road, Ikoyi",
        city: "Ikoyi",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4474, lng: 3.4394 },
      },
      priceKobo: 350000, // ₦3,500
      isPaid: true,
      scheduledPickup: daysAgo(7),
      actualPickup: daysAgo(7),
      estimatedDelivery: daysAgo(6),
      actualDelivery: daysAgo(6),
      createdAt: daysAgo(8),
      updatedAt: daysAgo(6),
    },
    // In transit
    {
      id: shipmentIds[1]!,
      trackingId: trackingIds[1]!,
      status: "in_transit",
      businessId: business1Id,
      driverId: driver2Id,
      customerId: customerUser2Id,
      description: "Fashion — Designer handbags (x3)",
      weightKg: 2.1,
      pickupAddress: {
        street: "30 Allen Avenue, Ikeja",
        city: "Ikeja",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.6018, lng: 3.3515 },
      },
      deliveryAddress: {
        street: "12 Aba Road, Port Harcourt",
        city: "Port Harcourt",
        state: "Rivers",
        country: "Nigeria",
        coordinates: { lat: 4.8156, lng: 7.0498 },
      },
      currentLocation: { lat: 5.9631, lng: 5.4328 },
      priceKobo: 1200000, // ₦12,000
      isPaid: true,
      scheduledPickup: daysAgo(1),
      actualPickup: daysAgo(1),
      estimatedDelivery: new Date(Date.now() + 86400000),
      createdAt: daysAgo(2),
      updatedAt: new Date(),
    },
    // Out for delivery
    {
      id: shipmentIds[2]!,
      trackingId: trackingIds[2]!,
      status: "out_for_delivery",
      businessId: business2Id,
      driverId: driver3Id,
      customerId: customerUser3Id,
      description: "Documents — Legal papers",
      weightKg: 0.2,
      pickupAddress: {
        street: "Plot 22, Ahmadu Bello Way",
        city: "Abuja",
        state: "FCT",
        country: "Nigeria",
        coordinates: { lat: 9.0765, lng: 7.3986 },
      },
      deliveryAddress: {
        street: "8 Apo Road, Garki",
        city: "Abuja",
        state: "FCT",
        country: "Nigeria",
        coordinates: { lat: 8.9938, lng: 7.4729 },
      },
      currentLocation: { lat: 9.0234, lng: 7.4321 },
      priceKobo: 150000, // ₦1,500
      isPaid: true,
      scheduledPickup: new Date(),
      actualPickup: new Date(),
      estimatedDelivery: new Date(Date.now() + 3600000 * 2),
      createdAt: daysAgo(1),
      updatedAt: new Date(),
    },
    // Pending
    {
      id: shipmentIds[3]!,
      trackingId: trackingIds[3]!,
      status: "pending",
      businessId: business1Id,
      customerId: customerUser4Id,
      description: "Food items — Foodstuff package (15kg)",
      weightKg: 15,
      pickupAddress: {
        street: "25 Market Road, Onitsha",
        city: "Onitsha",
        state: "Anambra",
        country: "Nigeria",
        coordinates: { lat: 6.1423, lng: 6.7933 },
      },
      deliveryAddress: {
        street: "10 Ogui Road, Enugu",
        city: "Enugu",
        state: "Enugu",
        country: "Nigeria",
        coordinates: { lat: 6.4547, lng: 7.5086 },
      },
      priceKobo: 800000, // ₦8,000
      isPaid: false,
      scheduledPickup: new Date(Date.now() + 86400000),
      estimatedDelivery: new Date(Date.now() + 86400000 * 2),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // Assigned
    {
      id: shipmentIds[4]!,
      trackingId: trackingIds[4]!,
      status: "assigned",
      businessId: business2Id,
      driverId: driver3Id,
      customerId: customerUser1Id,
      description: "Machinery — Industrial spare parts",
      weightKg: 45,
      pickupAddress: {
        street: "Tin Can Island Port",
        city: "Apapa",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4395, lng: 3.3599 },
      },
      deliveryAddress: {
        street: "KM 5 Kano-Zaria Road",
        city: "Kano",
        state: "Kano",
        country: "Nigeria",
        coordinates: { lat: 11.9964, lng: 8.5167 },
      },
      priceKobo: 5500000, // ₦55,000
      isPaid: true,
      scheduledPickup: new Date(Date.now() + 3600000 * 6),
      estimatedDelivery: new Date(Date.now() + 86400000 * 3),
      createdAt: daysAgo(1),
      updatedAt: new Date(),
    },
    // Picked up
    {
      id: shipmentIds[5]!,
      trackingId: trackingIds[5]!,
      status: "picked_up",
      businessId: business1Id,
      driverId: driver2Id,
      customerId: customerUser2Id,
      description: "Pharmaceuticals — Medical supplies",
      weightKg: 8,
      pickupAddress: {
        street: "3 Hospital Road, Surulere",
        city: "Surulere",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.5008, lng: 3.3526 },
      },
      deliveryAddress: {
        street: "University of Lagos Teaching Hospital",
        city: "Yaba",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.5165, lng: 3.3824 },
      },
      currentLocation: { lat: 6.5086, lng: 3.3675 },
      priceKobo: 450000, // ₦4,500
      isPaid: true,
      scheduledPickup: new Date(),
      actualPickup: new Date(),
      estimatedDelivery: new Date(Date.now() + 3600000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // Failed
    {
      id: shipmentIds[6]!,
      trackingId: trackingIds[6]!,
      status: "failed",
      businessId: business2Id,
      driverId: driver3Id,
      customerId: customerUser3Id,
      description: "Fragile — Glassware set",
      weightKg: 3,
      pickupAddress: {
        street: "18 Broad Street, Lagos Island",
        city: "Lagos Island",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.455, lng: 3.3954 },
      },
      deliveryAddress: {
        street: "45 Awolowo Road, Ikoyi",
        city: "Ikoyi",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4374, lng: 3.4279 },
      },
      priceKobo: 250000, // ₦2,500
      isPaid: false,
      scheduledPickup: daysAgo(3),
      actualPickup: daysAgo(3),
      estimatedDelivery: daysAgo(2),
      createdAt: daysAgo(4),
      updatedAt: daysAgo(2),
    },
    // Cancelled
    {
      id: shipmentIds[7]!,
      trackingId: trackingIds[7]!,
      status: "cancelled",
      businessId: business1Id,
      customerId: customerUser4Id,
      description: "Clothing — Agbada fabric (bulk)",
      weightKg: 12,
      pickupAddress: {
        street: "Balogun Market, Lagos Island",
        city: "Lagos Island",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4536, lng: 3.3954 },
      },
      deliveryAddress: {
        street: "Dugbe Market, Ibadan",
        city: "Ibadan",
        state: "Oyo",
        country: "Nigeria",
        coordinates: { lat: 7.3964, lng: 3.9145 },
      },
      priceKobo: 600000, // ₦6,000
      isPaid: false,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(4),
    },
    // Another delivered (different business)
    {
      id: shipmentIds[8]!,
      trackingId: trackingIds[8]!,
      status: "delivered",
      businessId: business2Id,
      driverId: driver3Id,
      customerId: customerUser1Id,
      description: "Electronics — Laptop (HP EliteBook)",
      weightKg: 2.5,
      pickupAddress: {
        street: "Wuse Zone 5, Abuja",
        city: "Abuja",
        state: "FCT",
        country: "Nigeria",
        coordinates: { lat: 9.0833, lng: 7.4833 },
      },
      deliveryAddress: {
        street: "Maitama District, Abuja",
        city: "Abuja",
        state: "FCT",
        country: "Nigeria",
        coordinates: { lat: 9.0836, lng: 7.4918 },
      },
      priceKobo: 700000, // ₦7,000
      isPaid: true,
      scheduledPickup: daysAgo(10),
      actualPickup: daysAgo(10),
      estimatedDelivery: daysAgo(9),
      actualDelivery: daysAgo(9),
      createdAt: daysAgo(11),
      updatedAt: daysAgo(9),
    },
    // Pending (unpaid)
    {
      id: shipmentIds[9]!,
      trackingId: trackingIds[9]!,
      status: "pending",
      businessId: business2Id,
      customerId: customerUser2Id,
      description: "Agricultural — Cashew nuts (50kg bag)",
      weightKg: 50,
      pickupAddress: {
        street: "Ogbomosho Farm Road",
        city: "Ogbomosho",
        state: "Oyo",
        country: "Nigeria",
        coordinates: { lat: 8.1306, lng: 4.2419 },
      },
      deliveryAddress: {
        street: "Apapa Port, Warehouse B",
        city: "Apapa",
        state: "Lagos",
        country: "Nigeria",
        coordinates: { lat: 6.4395, lng: 3.3599 },
      },
      priceKobo: 9500000, // ₦95,000
      isPaid: false,
      scheduledPickup: new Date(Date.now() + 86400000 * 2),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  // ── 5. Shipment events ────────────────────────────────────────────────────

  console.log("  → Inserting shipment events...");

  await db.insert(schema.shipmentEvents).values([
    // Events for delivered shipment [0]
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "pending",
      message: "Shipment created and awaiting pickup.",
      createdAt: daysAgo(8),
    },
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "assigned",
      message: "Driver Babatunde Adeleke has been assigned.",
      createdAt: daysAgo(8),
    },
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "picked_up",
      message: "Package picked up from sender at Lekki.",
      location: { lat: 6.4281, lng: 3.4219 },
      createdAt: daysAgo(7),
    },
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "in_transit",
      message: "Shipment is on its way to the destination.",
      location: { lat: 6.436, lng: 3.43 },
      createdAt: daysAgo(7),
    },
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "out_for_delivery",
      message: "Driver is 5 minutes away.",
      location: { lat: 6.445, lng: 3.438 },
      createdAt: daysAgo(6),
    },
    {
      id: id(),
      shipmentId: shipmentIds[0]!,
      status: "delivered",
      message: "Package delivered and signed for by Ngozi Adaeze.",
      location: { lat: 6.4474, lng: 3.4394 },
      createdAt: daysAgo(6),
    },

    // Events for in_transit shipment [1]
    {
      id: id(),
      shipmentId: shipmentIds[1]!,
      status: "pending",
      message: "Shipment created.",
      createdAt: daysAgo(2),
    },
    {
      id: id(),
      shipmentId: shipmentIds[1]!,
      status: "assigned",
      message: "Driver Chidi Eze assigned for inter-state delivery.",
      createdAt: daysAgo(2),
    },
    {
      id: id(),
      shipmentId: shipmentIds[1]!,
      status: "picked_up",
      message: "Package collected from Ikeja store.",
      location: { lat: 6.6018, lng: 3.3515 },
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      shipmentId: shipmentIds[1]!,
      status: "in_transit",
      message: "En route to Port Harcourt via East-West Road.",
      location: { lat: 5.9631, lng: 5.4328 },
      createdAt: daysAgo(1),
    },

    // Events for out_for_delivery shipment [2]
    {
      id: id(),
      shipmentId: shipmentIds[2]!,
      status: "pending",
      message: "Shipment created.",
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      shipmentId: shipmentIds[2]!,
      status: "assigned",
      message: "Driver Fatima assigned.",
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      shipmentId: shipmentIds[2]!,
      status: "picked_up",
      message: "Documents collected from SwiftCargo Abuja office.",
      location: { lat: 9.0765, lng: 7.3986 },
      createdAt: new Date(),
    },
    {
      id: id(),
      shipmentId: shipmentIds[2]!,
      status: "out_for_delivery",
      message: "Driver is out for delivery. ETA: 2 hours.",
      location: { lat: 9.0234, lng: 7.4321 },
      createdAt: new Date(),
    },

    // Events for assigned shipment [4]
    {
      id: id(),
      shipmentId: shipmentIds[4]!,
      status: "pending",
      message: "Heavy cargo shipment created.",
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      shipmentId: shipmentIds[4]!,
      status: "assigned",
      message: "Driver Fatima Suleiman and van assigned for bulk cargo.",
      createdAt: daysAgo(1),
    },

    // Events for picked_up shipment [5]
    {
      id: id(),
      shipmentId: shipmentIds[5]!,
      status: "pending",
      message: "Medical supplies shipment created.",
      createdAt: new Date(),
    },
    {
      id: id(),
      shipmentId: shipmentIds[5]!,
      status: "assigned",
      message: "Driver Chidi Eze assigned — urgent delivery.",
      createdAt: new Date(),
    },
    {
      id: id(),
      shipmentId: shipmentIds[5]!,
      status: "picked_up",
      message: "Medical supplies picked up and verified.",
      location: { lat: 6.5008, lng: 3.3526 },
      createdAt: new Date(),
    },

    // Events for failed shipment [6]
    {
      id: id(),
      shipmentId: shipmentIds[6]!,
      status: "pending",
      message: "Fragile item shipment created.",
      createdAt: daysAgo(4),
    },
    {
      id: id(),
      shipmentId: shipmentIds[6]!,
      status: "assigned",
      message: "Driver assigned.",
      createdAt: daysAgo(4),
    },
    {
      id: id(),
      shipmentId: shipmentIds[6]!,
      status: "picked_up",
      message: "Package picked up from sender.",
      location: { lat: 6.455, lng: 3.3954 },
      createdAt: daysAgo(3),
    },
    {
      id: id(),
      shipmentId: shipmentIds[6]!,
      status: "in_transit",
      message: "Shipment in transit.",
      createdAt: daysAgo(3),
    },
    {
      id: id(),
      shipmentId: shipmentIds[6]!,
      status: "failed",
      message:
        "Delivery failed — customer unavailable after 3 attempts. Item returned to sender.",
      location: { lat: 6.4374, lng: 3.4279 },
      createdAt: daysAgo(2),
    },

    // Events for cancelled shipment [7]
    {
      id: id(),
      shipmentId: shipmentIds[7]!,
      status: "pending",
      message: "Bulk clothing shipment created.",
      createdAt: daysAgo(5),
    },
    {
      id: id(),
      shipmentId: shipmentIds[7]!,
      status: "cancelled",
      message:
        "Shipment cancelled by business — customer requested cancellation.",
      createdAt: daysAgo(4),
    },

    // Events for second delivered shipment [8]
    {
      id: id(),
      shipmentId: shipmentIds[8]!,
      status: "pending",
      message: "Laptop shipment created.",
      createdAt: daysAgo(11),
    },
    {
      id: id(),
      shipmentId: shipmentIds[8]!,
      status: "assigned",
      message: "Driver Fatima Suleiman assigned.",
      createdAt: daysAgo(11),
    },
    {
      id: id(),
      shipmentId: shipmentIds[8]!,
      status: "picked_up",
      message: "Laptop picked up and inspected.",
      location: { lat: 9.0833, lng: 7.4833 },
      createdAt: daysAgo(10),
    },
    {
      id: id(),
      shipmentId: shipmentIds[8]!,
      status: "in_transit",
      message: "In transit within Abuja.",
      createdAt: daysAgo(10),
    },
    {
      id: id(),
      shipmentId: shipmentIds[8]!,
      status: "delivered",
      message: "Laptop delivered and received by Ngozi Adaeze.",
      location: { lat: 9.0836, lng: 7.4918 },
      createdAt: daysAgo(9),
    },

    // Pending shipments [3], [9] — just creation event
    {
      id: id(),
      shipmentId: shipmentIds[3]!,
      status: "pending",
      message: "Shipment created and pending assignment.",
      createdAt: new Date(),
    },
    {
      id: id(),
      shipmentId: shipmentIds[9]!,
      status: "pending",
      message: "Bulk agricultural shipment created.",
      createdAt: new Date(),
    },
  ]);

  // ── 6. Notifications ──────────────────────────────────────────────────────

  console.log("  → Inserting notifications...");

  await db.insert(schema.notifications).values([
    {
      id: id(),
      userId: customerUser1Id,
      type: "email",
      title: "Your shipment has been delivered!",
      message: `Your package (${trackingIds[0]}) was successfully delivered. Thank you for using IsoTrack.`,
      isRead: true,
      status: "sent",
      createdAt: daysAgo(6),
    },
    {
      id: id(),
      userId: customerUser2Id,
      type: "sms",
      title: "Shipment in transit",
      message: `Your IsoTrack shipment ${trackingIds[1]} is on its way to Port Harcourt. ETA: Tomorrow.`,
      isRead: false,
      status: "sent",
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      userId: customerUser3Id,
      type: "email",
      title: "Driver is on the way",
      message: `Driver Fatima is out for delivery of your package (${trackingIds[2]}). ETA: 2 hours.`,
      isRead: false,
      status: "sent",
      createdAt: new Date(),
    },
    {
      id: id(),
      userId: businessUser1Id,
      type: "email",
      title: "New shipment created",
      message: `A new shipment (${trackingIds[3]}) has been created and is awaiting driver assignment.`,
      isRead: false,
      status: "sent",
      createdAt: new Date(),
    },
    {
      id: id(),
      userId: driverUser3Id,
      type: "push",
      title: "New delivery assigned",
      message: `You have been assigned a new delivery (${trackingIds[2]}). Please pick up from SwiftCargo Abuja.`,
      isRead: true,
      status: "sent",
      createdAt: daysAgo(1),
    },
    {
      id: id(),
      userId: customerUser3Id,
      type: "email",
      title: "Delivery failed",
      message: `We were unable to deliver your package (${trackingIds[6]}). It has been returned to the sender. Contact support to reschedule.`,
      isRead: false,
      status: "sent",
      createdAt: daysAgo(2),
    },
    {
      id: id(),
      userId: customerUser1Id,
      type: "email",
      title: "Another package delivered",
      message: `Your laptop shipment (${trackingIds[8]}) was successfully delivered to Maitama. Enjoy!`,
      isRead: true,
      status: "sent",
      createdAt: daysAgo(9),
    },
  ]);

  console.log("\n✅ Seed complete! Here's a summary:\n");
  console.log("  👤 Users        : 9 (2 businesses, 3 drivers, 4 customers)");
  console.log("  🏢 Businesses   : 2 (Jumia Logistics NG, SwiftCargo Nigeria)");
  console.log("  🚗 Drivers      : 3 (bike, car, van)");
  console.log("  📦 Shipments    : 10 (all statuses covered)");
  console.log("  📋 Events       : 32 (full audit trail)");
  console.log("  🔔 Notifications: 7");
  console.log("\n  🔑 All accounts use password: Password123!");
  console.log("\n  Sample credentials:");
  console.log("    Business : admin@jumialogistics.ng / Password123!");
  console.log("    Driver   : tunde.rider@isotrack.ng / Password123!");
  console.log("    Customer : ngozi.customer@gmail.com / Password123!");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
