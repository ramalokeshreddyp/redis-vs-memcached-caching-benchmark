-- Create database schema for product catalog
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed 100,000 rows
-- We use RPAD to fill descriptions to 1920 characters so the final returned product JSON is ~2KB.
INSERT INTO products (name, description, price, sku)
SELECT
    'Product ' || i,
    RPAD('Detailed specifications for Product ' || i || '. This premium item is engineered for optimal efficiency, durability, and reliability. It features advanced technology, high-quality materials, and a sleek user-friendly design. It has been rigorously tested to perform under high workloads and extreme conditions, ensuring maximum productivity and lifespan. ', 1920, 'abcdefghijklmnopqrstuvwxyz '),
    ROUND((random() * 990 + 10)::numeric, 2),
    'SKU-' || LPAD(i::text, 6, '0') || '-' || FLOOR(random() * 90000 + 10000)::text
FROM generate_series(1, 100000) AS i
ON CONFLICT (sku) DO NOTHING;
