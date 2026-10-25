using Microsoft.EntityFrameworkCore;
using ZusStoreStock.Models;

namespace ZusStoreStock.Data;

public class ZusStoreStockContext : DbContext
{
    public ZusStoreStockContext(DbContextOptions<ZusStoreStockContext> options) : base(options) { }

    public DbSet<User> Users { get; set; }

    public DbSet<Product> Products { get; set; }
    public DbSet<StockBatch> StockBatches { get; set; }
    public DbSet<StockMove> StockMoves { get; set; }

    public DbSet<StoreOrder> StoreOrders { get; set; }
    public DbSet<StoreOrderLine> StoreOrderLines { get; set; }

    public DbSet<StockCheck> StockChecks { get; set; }
    public DbSet<StockCheckLine> StockCheckLines { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Enums are stored as text (Food, Ambient, Add ...), as they already are in your database.
        modelBuilder.Entity<Product>().Property(p => p.Category).HasConversion<string>();
        modelBuilder.Entity<Product>().Property(p => p.StorageZone).HasConversion<string>();
        modelBuilder.Entity<StockMove>().Property(m => m.Type).HasConversion<string>();

        modelBuilder.Entity<User>().HasIndex(u => u.Username).IsUnique();
        modelBuilder.Entity<Product>().HasIndex(p => p.Name).IsUnique();

        modelBuilder.Entity<StoreOrder>().Property(o => o.OrderNumber).HasMaxLength(30);
        modelBuilder.Entity<StoreOrder>().HasIndex(o => o.OrderNumber).IsUnique();

        // A product that appears in an order or a stock check cannot be deleted.
        modelBuilder.Entity<StoreOrderLine>()
            .HasOne(l => l.Product).WithMany()
            .HasForeignKey(l => l.ProductId)
            .OnDelete(DeleteBehavior.Restrict);

        modelBuilder.Entity<StockCheckLine>()
            .HasOne(l => l.Product).WithMany()
            .HasForeignKey(l => l.ProductId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}