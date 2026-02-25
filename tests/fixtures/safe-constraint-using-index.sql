-- Safe: UNIQUE using pre-built index (instant metadata operation)
ALTER TABLE businesses ADD CONSTRAINT "UQ_businesses_owner_id" UNIQUE USING INDEX "UQ_businesses_owner_id";

-- Safe: PRIMARY KEY using pre-built index (instant metadata operation)
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY USING INDEX users_pkey_idx;
