using System.ComponentModel.DataAnnotations;

namespace ZusStoreStock.Models;

public class User
{
    public int Id { get; set; }

    [Required(ErrorMessage = "Please enter a username."), StringLength(50)]
    public string Username { get; set; } = string.Empty;

    public string PasswordHash { get; set; } = string.Empty;

    [StringLength(100)] public string FullName { get; set; } = string.Empty;
    [StringLength(100)] public string Outlet { get; set; } = string.Empty;

    public string Role { get; set; } = "Staff";   // Staff or Admin
}