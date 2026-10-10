CREATE TABLE "public"."orders" (
    "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    "user_id" bigint NOT NULL,
    "status" order_status DEFAULT 'new'::order_status NOT NULL,
    "total" numeric(12,2) DEFAULT 0,
    "double_total" numeric GENERATED ALWAYS AS ((total * (2)::numeric)) STORED,
    CONSTRAINT "orders_pkey" PRIMARY KEY (id),
    CONSTRAINT "orders_total_check" CHECK ((total >= (0)::numeric)),
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id);
